# Run OLLAMA in local

```sh
docker compose up
```

- Pull the model to use

```
docker exec -it bonsai-llm bash
ollama pull phi3:mini
ollama run qwen:7b

```