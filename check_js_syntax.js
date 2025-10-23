const fs = require('fs');
const files = ['p:/C_coding/Python/FinanceManager/static/js/dynamic_app.js','p:/C_coding/Python/FinanceManager/static/js/pages/transactions.js'];
let ok=true;
for(const f of files){
  try{
    const src = fs.readFileSync(f,'utf8');
    new Function(src);
    console.log(f+': OK');
  }catch(e){
    console.error(f+': SYNTAX ERROR');
    console.error(e.toString());
    ok=false;
  }
}
process.exit(ok?0:2);
