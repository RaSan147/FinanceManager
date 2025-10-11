from pathlib import Path
s=Path('p:/C_coding/Python/FinanceManager/static/js/todo.js').read_text()
for i,ch in enumerate(s[:20]):
    print(i, ch, ord(ch))
print('SNIPPET:', repr(s[:10]))
