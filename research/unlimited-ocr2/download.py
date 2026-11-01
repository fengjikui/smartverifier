"""只下载固定版本的公开 BF16 权重，不执行模型仓库 Python 代码。"""
import os
from pathlib import Path

os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '30')
from huggingface_hub import snapshot_download

ROOT = Path(__file__).resolve().parents[2]
if __name__ == '__main__':
    print(snapshot_download(
        repo_id='mlx-community/Unlimited-OCR-2-bf16',
        revision='850d1e483f5a82a0597f0a45aac31b07ba840df2',
        local_dir=ROOT/'var/research-unlimited-ocr2-20261101/model-bf16',
        allow_patterns=['*.json', '*.safetensors', '*.jinja', 'README.md'],
        max_workers=1))
