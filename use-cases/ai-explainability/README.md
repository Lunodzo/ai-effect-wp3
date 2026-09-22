# AI Explainability Pipeline

This use case wraps the vendored [AI Explainability toolbox](services/explainability_runner/toolbox/README.md)
as one AI-EFFECT workflow node. The toolbox uses SHAP to explain tabular and
time-series model predictions and produces audit artifacts such as a flattened
CSV, optional Excel workbook, and optional notebook report.

The vendored toolbox preserves its upstream package metadata, including original
author, maintainer, and MIT license information, in
`services/explainability_runner/toolbox/ai_explainability.egg-info/PKG-INFO`.

## Pipeline

```
explainability_runner
       Explain
    (DataSource)
```

The single service is intentional. The upstream toolbox already dispatches to
tabular and time-series explainers from its `analysis` configuration. Splitting
those internal paths into separate workflow nodes would add orchestration
overhead without a data-exchange benefit.

`web_ui` is a supporting service, not a workflow node. It is deployed by
`docker-compose.yml` to submit workflows and display their results, but it is
outside `services/`, absent from `connections.json`, and excluded from the
onboarding export. Only `explainability_runner` is called by the orchestrator.

## Layout

```
ai-explainability/
├── assets/
│   ├── models/                         # place model files here
│   └── data/                           # place CSV, TSV, or Parquet data here
├── common/concurrent.py                # AI-EFFECT control interface
├── services/
│   └── explainability_runner/          # adapter plus vendored toolbox source
├── web_ui/                              # shared manifest-driven Bootstrap UI
├── connections.json
├── ui.json
├── docker-compose.yml
└── generate-export.sh
```

## Input contract

### Runnable sample

The upstream WP3 repository does not publish a serialized model, so the thin
use case includes a reproducible preparation script. It downloads the
upstream energy CSV, trains a small Random Forest, and writes ignored assets:

```bash
python scripts/prepare-sample.py
```

Then use the generated files in the web UI, or paste the contents of
`sample-config.json` into the configuration field. Completed runs return a
Markdown feature-influence report and links to generated artifacts.

Upload the model and dataset directly in the web UI, then submit the JSON
configuration. Uploaded files are stored on the shared workflow volume under
`/data/uploads/` and their paths are inserted into the configuration
automatically. Alternatively, mount files in `assets/` and use paths relative
to that directory. The runner accepts files only from `/assets` or its
controlled `/data/uploads/` directory.

For example, when using mounted assets:

```json
{
  "analysis": "tabular",
  "model_type": "random_forest",
  "model_path": "models/model.pkl",
  "dataset_path": "data/dataset.csv",
  "feature_names": ["wind_speed", "temperature"]
}
```

The adapter writes all results to `/data/<workflow_id>/<task_id>/` on the shared
Docker volume, returns `summary.json` as a file DataReference, and includes the
artifact names in its output. Set `save_excel` or `generate_notebook` in the
configuration to control optional reports.

## Running

1. Place supported model and data files in `assets/models/` and `assets/data/`.
2. Start the platform orchestrator from `orchestrator/`.
3. Run `./start.sh` from this directory.
4. Run `./generate-export.sh` to create `export.zip`.
5. Open `http://localhost:18204`, select a model and dataset in the upload
  fields, and submit the analysis configuration. Uploaded files replace
  `model_path` and `dataset_path` in the JSON editor.

The orchestrator reaches `explainability-runner` over the shared
`ai-effect-services` Docker network on port 8080. Host port 18201 is available
only for debugging.