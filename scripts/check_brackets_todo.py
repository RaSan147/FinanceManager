from pathlib import Path
s=Path('p:/C_coding/Python/FinanceManager/static/js/todo.js').read_text()
stack=[]
pairs={'{':'}','(':')','[':']'}
openers=set(pairs.keys())
closers=set(pairs.values())
for idx,ch in enumerate(s):
    if ch in openers:
        stack.append((ch,idx))
    elif ch in closers:
        if not stack:
            print('Unmatched closer',ch,'at index',idx,'line',s.count('\n',0,idx)+1)
            break
        last,li=stack[-1]
        if pairs[last]==ch:
            stack.pop()
        else:
            print('Mismatch',last,'vs',ch,'at index',idx,'line',s.count('\n',0,idx)+1)
            print('\nTop of stack (last 10 openers):')
            for o,i in stack[-10:]:
                print(' open',o,'at index',i,'line',s.count('\n',0,i)+1)
            # print nearby source
            start=max(0,idx-200)
            end=min(len(s), idx+200)
            print('\n--- SOURCE AROUND MISMATCH ---')
            print(s[start:end])
            break
else:
    print('Finished scan; remaining openers:',len(stack))
    if stack:
        print('\nRemaining openers (last 20):')
        for o,i in stack[-20:]:
            print(' open',o,'at index',i,'line',s.count('\n',0,i)+1)
