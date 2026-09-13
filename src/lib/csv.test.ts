import { describe, expect, it, vi } from 'vitest';
import { parseCsv, exportToCsv, serializeCsv } from './csv';

describe('CSV boundary',()=>{
 it('preserves quoted multiline, quotes and whitespace without data corruption',()=>{
  expect(parseCsv('name,notes\r\n"  Milk  ","line one\r\nline ""two"""\r\n')).toEqual([{name:'  Milk  ',notes:'line one\r\nline "two"'}]);
 });
 it.each(['name,name\na,b','name,cost\na','name,cost\na,1,extra','name\n"unfinished','name\n"closed"junk','name\nun"quoted'])('rejects ambiguous/malformed input %s',(csv)=>{
  expect(()=>parseCsv(csv)).toThrow();
 });
 it('keeps prototype-shaped headers as ordinary own data',()=>{
  const row=parseCsv('__proto__,constructor\nvalue,text')[0];
  expect(Object.hasOwn(row,'__proto__')).toBe(true);expect(row.__proto__).toBe('value');
 });
 it('neutralizes formula cells and headers before spreadsheet download',()=>{
  const blobs:Blob[]=[];
  vi.stubGlobal('URL',class {static createObjectURL(blob:Blob){blobs.push(blob);return 'blob:contract';}static revokeObjectURL=vi.fn();});
  const FakeBlob=class {textValue:string;constructor(parts:any[]){this.textValue=parts.join('');}};
  vi.stubGlobal('Blob',FakeBlob);
  vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
  exportToCsv('contract.csv',[{'=header':'\t=SUM(1,2)',name:'+97330000000',cost:'1.251'}]);
  const text=(blobs[0] as unknown as {textValue:string}).textValue;
  expect(text).toContain('"\'=header"');expect(text).toContain('"\'\t=SUM(1,2)"');expect(text).toContain('"\'+97330000000"');
  expect(text).toContain('"1.251"');expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:contract');
  vi.unstubAllGlobals();vi.restoreAllMocks();
 });
});

it('round-trips exact ordinary text, quoted headers and three-decimal strings',()=>{
 const source=[{'product,name':'"Milk"','cost_fils':'1251',notes:'Arabic: حليب\nline two'}];
 expect(parseCsv(serializeCsv(source))).toEqual(source);
});
it.each(['＝SUM(1,2)','  +cmd','＠value','\r=cmd'])('escapes alternate formula prefixes %s',(text)=>{
 expect(serializeCsv([{name:text}]).split('\r\n').slice(1).join('\r\n')).toMatch(/^"'/);
});
it('bounds imports and rejects lossy Unicode',()=>{
 expect(()=>parseCsv('name\n'+Array(10001).fill('x').join('\n'))).toThrow(/10,000/);
 expect(()=>parseCsv('name\n'+ 'x'.repeat(65537))).toThrow(/65,536/);
 expect(()=>parseCsv('name\n\ud800')).toThrow(/Unicode/);
 expect(()=>parseCsv('name\n\u0000')).toThrow(/control/);
 expect(()=>serializeCsv([{name:{nested:true}}])).toThrow(/scalar/);
});
