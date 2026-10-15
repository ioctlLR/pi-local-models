# pi-local-models
Local model discovery for PI Coding Agent

This supports any openai-api spec provider
- llama.cpp
- Ollama
- oMLX
- llama-swap
- MTPLX

## Installation:

```
pi install npm:pi-local-models
```

## Configuration

Create a minimal config for your local LLM harness:
```
{
    "url": "http://127.0.0.1:8080",
    "apiKey": "1234"
}
```

See a full example [here](./local-models.json)

Store the file at user level: ~/.pi/agent/local-models.json
Or at project level: ./.pi/agent/local-models.json

Run pi and perform the /models command to select any discovered [local-model].

## Per-model discovery

Values reported by the server's `/v1/models` take priority over the config file, which only fills in what the server leaves out:

| `/v1/models` field | Pi model setting |
| --- | --- |
| `context_length`, `max_model_len` or `meta.n_ctx` | context window (`contextWindow`) |
| `max_output_tokens` | max output tokens (`maxTokens`) |
| `architecture.input_modalities` | input types (`input`) |
| `pricing` (per token) | cost |
| `reasoning_effort` (from [llama-server-router](https://github.com/kkuroma/llama-server-router)) | reasoning, supported thinking levels, and how thinking is turned off |

When a model reports `reasoning_effort.default`, selecting that model sets pi's thinking level to it.