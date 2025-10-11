from pathlib import Path
s=Path('p:/C_coding/Python/FinanceManager/static/js/todo.js').read_text()
N=200
start = max(0, len(s)-N)
for i,ch in enumerate(s[start:], start):
    print(i, repr(ch))
print('\nLAST CHARS:')
print(s[-200:])