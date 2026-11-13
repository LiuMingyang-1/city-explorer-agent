'use strict';
// Both map providers use the same visible route frame. AMap's order is top,bottom,left,right.
(() => {
 function routeFrame({width,height,card}){
  const desktop=width>700;
  const left=desktop?Math.max(width/3+48,card.right+24):24,right=desktop?48:24;
  const top=desktop?60:36,bottom=desktop?60:Math.min(card.height+36,height-96);
  return {left,right,top,bottom,targetX:(left+width-right)/2,targetY:(top+height-bottom)/2,
   amap:[top,bottom,left,right],paddingTopLeft:[left,top],paddingBottomRight:[right,bottom]};
 }
 window.WanderMapLayout={routeFrame};
})();
