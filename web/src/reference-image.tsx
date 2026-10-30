import { regionPoints } from '../../shared/reference-geometry';
import type { ReferenceRegion } from '../../shared/admin';

/** 与图片共用 viewBox；留白、缩放和任意角度旋转均不改变区域的像素对应。 */
export function RegionOverlay({regions,width,height}:{regions:ReferenceRegion[];width:number;height:number}){
 return <svg className="ref-region-overlay" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label={`识别范围：${regions.filter(r=>r.kind==='focus').length}处重点，${regions.filter(r=>r.kind==='ignore').length}处忽略`} role="img">{regions.map(r=><polygon key={r.id} points={regionPoints(r).map(p=>`${p.x*width},${p.y*height}`).join(' ')} fill="none" stroke={r.kind==='focus'?'#23754e':'#d28c00'} strokeWidth="2" vectorEffect="non-scaling-stroke"><title>{r.kind==='focus'?'重点区域':'忽略区域'}{r.label?'：'+r.label:''}</title></polygon>)}</svg>;
}
export function ReferenceImage({src,alt,width,height,regions=[]}:{src:string;alt:string;width:number;height:number;regions?:ReferenceRegion[]}){
 return <svg className="ref-marked-image" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={alt}><image href={src} width={width} height={height}/>{regions.map(r=><polygon key={r.id} points={regionPoints(r).map(p=>`${p.x*width},${p.y*height}`).join(' ')} fill="none" stroke={r.kind==='focus'?'#23754e':'#d28c00'} strokeWidth="2" vectorEffect="non-scaling-stroke"><title>{r.kind==='focus'?'重点区域':'忽略区域'}</title></polygon>)}</svg>;
}
