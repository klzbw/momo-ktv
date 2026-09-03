import os, sys
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "0"
from huggingface_hub import snapshot_download
print("Downloading HTDemucs...")
p1 = snapshot_download("adefossez/HTDemucs", resume_download=True)
print("HTDemucs ->", p1)
print("Downloading HTDemucs-ft...")
p2 = snapshot_download("adefossez/HTDemucs-ft", resume_download=True)
print("HTDemucs-ft ->", p2)
print("DONE")
