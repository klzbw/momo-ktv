f = "C:/Users/Administrator/Desktop/ai-worker/worker.py"
c = open(f, encoding="utf-8").read()
old = """                if task:
                    got = True; idle_round = 0
                    self.handle(task)
                    break"""
new = """                if task:
                    got = True; idle_round = 0
                    try:
                        self.handle(task)
                    except Exception as e:
                        import traceback
                        log(f'task failed, skip to next: {e}')
                        traceback.print_exc()
                    break"""
if old in c:
    c = c.replace(old, new)
    open(f, "w", encoding="utf-8").write(c)
    print("patched: loop try/except added")
else:
    print("pattern not found")