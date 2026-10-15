const fs=require('node:fs'),path=require('node:path');
const repo=path.resolve(__dirname,'..'),out=path.join(repo,'.shots/board-rail');
const sharp=require(require.resolve('sharp',{paths:[path.resolve(repo,'../..'),repo]}));
(async()=>{
 const results=[];
 const a=JSON.parse(fs.readFileSync(path.join(out,'before/status.json'))),b=JSON.parse(fs.readFileSync(path.join(out,'after/status.json')));
 for(const c of a.captures){
  const left=await sharp(path.join(out,'before',c.name+'.png')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const right=await sharp(path.join(out,'after',c.name+'.png')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  if(left.info.width!==right.info.width||left.info.height!==right.info.height)throw Error('Unmatched image dimensions');
  let changed=0,sum=0,minX=Infinity,minY=Infinity,maxX=-1,maxY=-1;
  for(let p=0;p<left.data.length;p+=4){let d=0;for(let k=0;k<3;k++){const v=Math.abs(left.data[p+k]-right.data[p+k]);d=Math.max(d,v);sum+=v;}if(d>8){changed++;const i=p/4,x=i%left.info.width,y=Math.floor(i/left.info.width);minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}}
  results.push({name:c.name,width:left.info.width,height:left.info.height,changedPixelsThreshold8:changed,meanAbsoluteChannelDelta:sum/(left.info.width*left.info.height*3),bounds:changed?{minX,minY,maxX,maxY}:null,fixturePanes:[c.metrics.panes,b.captures.find(x=>x.name===c.name)?.metrics.panes]});
 }
 const am=JSON.parse(fs.readFileSync(path.join(out,'before/source-manifest.json'))),bm=JSON.parse(fs.readFileSync(path.join(out,'after/source-manifest.json')));
 const changedSources=Object.keys(am.hashes).filter(k=>am.hashes[k]!==bm.hashes[k]);
 fs.writeFileSync(path.join(out,'pixels.json'),JSON.stringify({humanVisualInspection:false,method:'sharp decoded RGBA numeric comparison, not semantic visual review',changedSources,results},null,2));
 console.log(JSON.stringify({changedSources,results},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
