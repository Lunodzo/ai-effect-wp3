"""AI-EFFECT adapter for the vendored AI Explainability toolbox."""

from __future__ import annotations

import base64
import json
import logging
import os
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np

# importing explain from the AI Explainability toolbox
from ai_explainability import explain
from common.concurrent import (
    ExecuteRequest,
    ExecuteResponse,
    TaskManager,
    run,
    run_in_background,
    task_manager,
)

logger = logging.getLogger(__name__)
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
ASSETS_DIR = Path(os.environ.get("ASSETS_DIR", "/assets")).resolve()
UPLOAD_DIR = (DATA_DIR / "uploads").resolve()


def _resolve_input(inputs: list[dict[str, Any]]) -> dict[str, Any]:
    if not inputs:
        raise ValueError("Explainer requires one JSON configuration input")

    reference = inputs[0]
    protocol = reference.get("protocol")
    uri = reference.get("uri", "")
    if protocol == "inline":
        payload = json.loads(base64.b64decode(uri).decode("utf-8"))
    elif protocol == "file":
        payload = json.loads(Path(uri).read_text(encoding="utf-8"))
    else:
        raise ValueError(f"Unsupported input protocol: {protocol!r}")

    if not isinstance(payload, dict):
        raise ValueError("Explainer input must be a JSON object")
    if isinstance(payload.get("config_json"), str):
        payload = json.loads(payload["config_json"])
    return payload.get("config", payload)


def _asset_path(value: Any, field_name: str) -> str:
    path = Path(str(value)).expanduser()
    if not path.is_absolute():
        path = ASSETS_DIR / path
    resolved = path.resolve()
    allowed_roots = (ASSETS_DIR, UPLOAD_DIR)
    if not any(root in resolved.parents for root in allowed_roots):
        raise ValueError(f"{field_name} must reference a file under {ASSETS_DIR} or {UPLOAD_DIR}")
    if not resolved.is_file():
        raise ValueError(f"{field_name} file was not found: {resolved}")
    return str(resolved)


def _prepare_config(raw_config: dict[str, Any], result_dir: Path) -> dict[str, Any]:
    config = dict(raw_config)
    for field in ("model_path", "dataset_path", "background_data_path", "test_data_path"):
        if config.get(field):
            config[field] = _asset_path(config[field], field)

    analysis = config.get("analysis")
    model_type = config.get("model_type")
    if analysis not in {"tabular", "timeseries"}:
        raise ValueError("analysis must be 'tabular' or 'timeseries'")
    if not isinstance(model_type, str) or not model_type:
        raise ValueError("model_type is required")
    if not config.get("model_path"):
        raise ValueError("model_path is required and must be placed in assets/models")

    config["output_dir"] = str(result_dir)
    config.setdefault("save_excel", True)
    config.setdefault("generate_notebook", False)
    return config


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")


def _write_report(path: Path, result: Any, config: dict[str, Any]) -> str:
    feature_names = list(getattr(result, "feature_names", []) or config.get("feature_names", []))
    shap_values = getattr(result, "shap_values", {})
    importance = []
    if shap_values:
        values = next(iter(shap_values.values()))
        means = abs(values).mean(axis=tuple(range(values.ndim - 1)))
        importance = sorted(
            zip(feature_names, means.tolist()), key=lambda item: item[1], reverse=True
        )

    lines = [
        f"# Explainability report: {config['model_type']}",
        "",
        f"- Analysis: `{config['analysis']}`",
        f"- Samples explained: `{len(getattr(result, 'raw_data_values', []) if getattr(result, 'raw_data_values', None) is not None else [])}`",
        "",
        "## Feature influence",
        "",
    ]
    lines.extend(f"- **{name}**: mean absolute SHAP `{value:.6g}`" for name, value in importance)
    report = "\n".join(lines) + "\n"
    path.write_text(report, encoding="utf-8")
    return report


def _write_visualizations(result: Any, result_dir: Path) -> list[dict[str, str]]:
    shap_values = getattr(result, "shap_values", {})
    raw_data = getattr(result, "raw_data_values", None)
    feature_names = list(getattr(result, "feature_names", []) or [])
    if not shap_values or raw_data is None:
        return []

    values = np.asarray(next(iter(shap_values.values())))
    data = np.asarray(raw_data)
    if values.ndim not in {2, 3} or data.ndim != values.ndim:
        return []
    is_timeseries = values.ndim == 3
    if is_timeseries:
        importance = np.abs(values).mean(axis=(0, 1))
        feature_values = values.mean(axis=1)
    else:
        importance = np.abs(values).mean(axis=0)
        feature_values = values
    if not feature_names:
        feature_names = [f"feature_{index}" for index in range(values.shape[-1])]

    order = np.argsort(importance)
    drawings: list[dict[str, str]] = []

    importance_path = result_dir / "shap_feature_importance.png"
    figure, axis = plt.subplots(figsize=(8, 4.5))
    axis.barh([feature_names[index] for index in order], importance[order], color="#e06b3c")
    axis.set_title("Global Feature Importance")
    axis.set_xlabel("Mean absolute SHAP value")
    figure.tight_layout()
    figure.savefig(importance_path, dpi=140)
    plt.close(figure)
    drawings.append({"signature": "shap_feature_importance", "uri": str(importance_path), "media_type": "image/png"})

    beeswarm_path = result_dir / "shap_beeswarm.png"
    figure, axis = plt.subplots(figsize=(8, 4.5))
    for position, index in enumerate(order):
        axis.scatter(feature_values[:, index], np.full(feature_values.shape[0], position), s=9, alpha=0.45)
    axis.set_yticks(range(len(order)), [feature_names[index] for index in order])
    axis.set_title("SHAP Feature Impact Distribution")
    axis.set_xlabel("SHAP value")
    axis.axvline(0, color="#64747d", linewidth=0.8)
    figure.tight_layout()
    figure.savefig(beeswarm_path, dpi=140)
    plt.close(figure)
    drawings.append({"signature": "shap_beeswarm", "uri": str(beeswarm_path), "media_type": "image/png"})

    if is_timeseries:
        temporal_path = result_dir / "shap_temporal_relevance.png"
        temporal_importance = np.abs(values).mean(axis=(0, 2))
        figure, axis = plt.subplots(figsize=(8, 4.2))
        steps = np.arange(values.shape[1])
        axis.plot(steps, temporal_importance, marker="o", color="#e06b3c", linewidth=2)
        axis.set_title("Temporal Relevance")
        axis.set_xlabel("History step")
        axis.set_ylabel("Mean absolute SHAP value")
        axis.set_xticks(steps, [f"t-{values.shape[1] - 1 - step}" for step in steps])
        axis.grid(alpha=0.25)
        figure.tight_layout()
        figure.savefig(temporal_path, dpi=140)
        plt.close(figure)
        drawings.append({"signature": "shap_temporal_relevance", "uri": str(temporal_path), "media_type": "image/png"})
    return drawings


def execute_Explain(request: ExecuteRequest) -> ExecuteResponse:
    task_manager.register_task(request.task_id, request)
    run_in_background(request.task_id, _run_explanation, request)
    return ExecuteResponse(status="running", task_id=request.task_id)


def _run_explanation(task_id: str, request: ExecuteRequest, manager: TaskManager) -> None:
    try:
        manager.update_progress(task_id, 5)
        result_dir = DATA_DIR / request.workflow_id / task_id
        result_dir.mkdir(parents=True, exist_ok=True)
        submitted_config = _resolve_input(request.inputs)
        submitted_config.update(request.parameters)
        config = _prepare_config(submitted_config, result_dir)
        manager.update_progress(task_id, 15)

        result = explain(**config)
        manager.update_progress(task_id, 80)

        explanation_csv = None
        if result is not None:
            try:
                explanation_csv_path = result_dir / "explanation.csv"
                result.to_dataframe().to_csv(explanation_csv_path, index=False)
                explanation_csv = str(explanation_csv_path)
            except Exception as exc:
                logger.warning("Could not create flattened explanation CSV: %s", exc)

            report_path = result_dir / "report.md"
            report_markdown = _write_report(report_path, result, config)
            drawings = _write_visualizations(result, result_dir)
        else:
            report_markdown = ""
            drawings = []

        artifacts = sorted(
            str(path.relative_to(result_dir))
            for path in result_dir.rglob("*")
            if path.is_file() and path.name != "summary.json"
        )
        summary = {
            "summary": "Explainability analysis completed.",
            "analysis": config["analysis"],
            "model_type": config["model_type"],
            "output_dir": str(result_dir),
            "explanation_csv": explanation_csv,
            "report_markdown": report_markdown,
            "artifacts": artifacts,
            "drawings": drawings,
        }
        summary_path = result_dir / "summary.json"
        _write_json(summary_path, summary)
        manager.complete_task(task_id, {"protocol": "file", "uri": str(summary_path), "format": "json"})
    except Exception as exc:
        logger.exception("Explainability task failed")
        manager.fail_task(task_id, str(exc))


if __name__ == "__main__":
    run(__import__(__name__))