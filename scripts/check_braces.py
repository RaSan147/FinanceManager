from pathlib import Path
p=Path(r'P:/C_coding/Python/FinanceManager/static/js/todo.js')
s=p.read_text(encoding='utf-8')
lines=s.splitlines()
bal=0
max_bal=0
max_i=0
for i,line in enumerate(lines, start=1):
    bal += line.count('{') - line.count('}')
    if bal>max_bal:
        max_bal=bal
        max_i=i
    if bal<0:
        print('Negative balance at line', i)
        break
else:
    print('Final balance', bal)
    print('Max balance', max_bal, 'at line', max_i)
    start=max(1, max_i-10)
    end=min(len(lines), max_i+10)
    print('\nContext around max imbalance (lines {}-{}):'.format(start, end))
    for j in range(start-1,end):
        print(f"{j+1:4}: {lines[j]}")
