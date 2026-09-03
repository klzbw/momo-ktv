lines = open("C:/Users/Administrator/Desktop/ai-worker/worker.py", encoding="utf-8").readlines()
# Find the first "if __name__" line
cut = -1
for i, line in enumerate(lines):
    if "if __name__" in line:
        cut = i + 2  # include this line and the next (main())
        break
print(f"cut at line {cut} (total {len(lines)})")
# Verify run_child in first part is complete
rc_start = -1
for i, line in enumerate(lines[:cut]):
    if "def run_child" in line:
        rc_start = i
        break
print(f"run_child at line {rc_start+1}")
for i in range(rc_start, min(rc_start+18, cut)):
    print(f"  {i+1}: {lines[i].rstrip()}")
# Truncate
new_lines = lines[:cut]
with open("C:/Users/Administrator/Desktop/ai-worker/worker.py", "w", encoding="utf-8") as f:
    f.writelines(new_lines)
print(f"truncated to {len(new_lines)} lines")