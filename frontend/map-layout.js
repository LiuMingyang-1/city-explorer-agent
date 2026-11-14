'use strict';
// Both map providers use the same visible route frame. AMap's order is top,bottom,left,right.
(() => {
 function visiblePanels(){
  return ['activity-detail','preferences-panel'].map(id=>document.getElementById?.(id)).filter(panel=>panel&&!panel.hidden&&panel.getBoundingClientRect).map(panel=>panel.getBoundingClientRect());
 }
 function routeFrame({width,height,card,panels=[]}){
  const desktop=width>700;
  let left=desktop?Math.max(width/3+48,card.right+24):24,right=desktop?48:24;
  let top=desktop?60:36,bottom=desktop?60:Math.min(card.height+36,height-96);
  // Fit inside the largest remaining rectangle, leaving a gap around open
  // panels. On compact screens the useful space may be below the panel.
  let frames=[{left,right:width-right,top,bottom:height-bottom}];
  for(const panel of panels){
   frames=frames.flatMap(f=>{
    if(panel.left>=f.right+24||panel.right<=f.left-24||panel.top>=f.bottom+24||panel.bottom<=f.top-24)return [f];
    return [{...f,right:Math.min(f.right,panel.left-24)},{...f,left:Math.max(f.left,panel.right+24)},{...f,bottom:Math.min(f.bottom,panel.top-24)},{...f,top:Math.max(f.top,panel.bottom+24)}].filter(r=>r.right>r.left&&r.bottom>r.top);
   });
  }
  const area=f=>(f.right-f.left)*(f.bottom-f.top),best=frames.sort((a,b)=>area(b)-area(a))[0];
  if(best){left=best.left;right=width-best.right;top=best.top;bottom=height-best.bottom;}
  return {left,right,top,bottom,targetX:(left+width-right)/2,targetY:(top+height-bottom)/2,
   amap:[top,bottom,left,right],paddingTopLeft:[left,top],paddingBottomRight:[right,bottom]};
 }
 window.WanderMapLayout={routeFrame,visiblePanels};
})();
