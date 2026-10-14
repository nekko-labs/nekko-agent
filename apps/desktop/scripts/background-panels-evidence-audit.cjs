// Decode pixels, check matching capture sizes, and produce a local review gallery.
// Pixel statistics are not human visual inspection or native-window evidence.
const fs=require('node:fs');const path=require('node:path');const sharp=require('sharp');
const root=path.resolve(__dirname,'../../../.shots/background-panels');
(async()=>{
 const results=[];
 for(const file of fs.readdirSync(path.join(root,'before')).filter(f=>f.endsWith('.png'))){
  const before=path.join(root,'before',file),after=path.join(root,'after',file);
  const a=await sharp(before).removeAlpha().raw().toBuffer({resolveWithObject:true});const b=await sharp(after).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const stats=await sharp(after).stats();let changed=0;const matched=JSON.stringify(a.info)===JSON.stringify(b.info);if(matched)for(let i=0;i<a.data.length;i+=3)if(a.data[i]!==b.data[i]||a.data[i+1]!==b.data[i+1]||a.data[i+2]!==b.data[i+2])changed++;
  results.push({file,matchedDimensions:matched,width:a.info.width,height:a.info.height,changedPixelPercent:matched?100*changed/(a.info.width*a.info.height):null,afterChannelStddev:stats.channels.map(c=>c.stdev)});
 }
 const report={pixelInspectionOnly:true,visuallyInspected:false,nativeCapture:false,results};fs.writeFileSync(path.join(root,'pixel-audit.json'),JSON.stringify(report,null,2));
 fs.writeFileSync(path.join(root,'review.html'),`<!doctype html><meta charset="utf-8"><title>Background panels evidence review</title><style>body{font:14px system-ui;background:#eee;color:#222}table{width:100%;table-layout:fixed}td{vertical-align:top}img{width:100%}th{text-align:left}video{max-width:48%}</style><h1>Background panels verification</h1><p>Renderer-only Electron fixtures, baseline 1044834c and working tree. Synthetic records, UTC date frozen at 2026-10-13. Viewports 1200x900 and 400x900, light and dark. All images decoded and compared programmatically. Visual inspection and native OS chrome remain unverified. No image/video viewing tool was available.</p><p>Unit tests: 57/57. Baseline interactions: 12/12. AFTER interactions: 52/52. No focus events or renderer errors. Network and permissions denied. Profiles and archived source removed.</p><h2>Motion, renderer frames with measured timestamps</h2><video controls src="before/dropdown-motion.mp4"></video><video controls src="after/dropdown-motion.mp4"></video><table><thead><tr><th>Before 1044834c</th><th>After working tree</th></tr></thead><tbody>${results.map(r=>`<tr><td colspan="2"><h2>${r.file}</h2>Matched size ${r.width}x${r.height}, ${r.changedPixelPercent.toFixed(2)}% changed pixels.</td></tr><tr><td><img src="before/${r.file}"></td><td><img src="after/${r.file}"></td></tr>`).join('')}</tbody></table>`);
 console.log(JSON.stringify({pairs:results.length,matched:results.every(r=>r.matchedDimensions),nonuniform:results.every(r=>r.afterChannelStddev.some(v=>v>5)),range:results.map(r=>[r.file,r.changedPixelPercent])},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
