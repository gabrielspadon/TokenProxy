"""Regenerate independent fixtures with uv run --with tiktoken==0.14.0 python this_file."""
import json
from pathlib import Path
import tiktoken

texts = ["", "hello world", "お誕生日おめでとう", "你好，世界", "café cafe\u0301", "👩🏽‍💻 🌊 🇨🇦", "def fib(n):\n    return n if n < 2 else fib(n-1) + fib(n-2)\n", '{"tool":"read","arguments":{"path":"/tmp/a.txt"}}', "<|endoftext|><|fim_prefix|><|im_start|>", "\x00\t\r\n  spaces   1234567890", "مرحبا بالعالم", "x" * 4096]
records = []
for encoding in ["cl100k_base", "o200k_base"]:
    api = tiktoken.get_encoding(encoding)
    for text in texts:
        records.append({"encoding": encoding, "text": text, "ids": api.encode_ordinary(text)})
output = Path(__file__).parents[2] / "fixtures/tokenizer/tiktoken-0.14.0.json"
output.write_text(json.dumps({"reference": "openai/tiktoken", "version": tiktoken.__version__, "special_tokens": "ordinary text", "records": records}, ensure_ascii=False, indent=2) + "\n")
print(f"Wrote {len(records)} independent tiktoken fixtures")
