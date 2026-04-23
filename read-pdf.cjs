const { PDFParse } = require('pdf-parse');
const fs = require('fs');
new PDFParse().parse(fs.readFileSync('./docs/Deye Modbus.pdf')).then(d => {
  const all = d.text.split('\n');
  // Print all lines around register numbers 240-285
  all.forEach((l, i) => {
    if (/\b(2[4-7][0-9])\b/.test(l) && l.trim().length > 2) {
      console.log(`[${i}] ${JSON.stringify(l)}`);
    }
  });
}).catch(e => console.error(e.message));
