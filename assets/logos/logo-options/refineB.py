import math
def hexp(cx,cy,R,p=2):
    angs=[0,60,120,180,240,300]  # flat-top
    return [(round(cx+R*math.cos(math.radians(a)),p),round(cy+R*math.sin(math.radians(a)),p)) for a in angs]
def path(pts):
    return "M "+" L ".join(f"{x} {y}" for x,y in pts)+" Z"
def cluster(cx,cy,R,gap):
    d=math.sqrt(3)*R+gap
    cs=[(cx,cy)]
    for a in [0,60,120,180,240,300]:
        cs.append((cx+d*math.cos(math.radians(a)), cy+d*math.sin(math.radians(a))))
    return cs

# centers: index0 center, then 0,60,120,180,240,300 -> E, NE? cos(0)=+x right; in svg y down so 60deg is lower-right
# order: 1=right,2=lower-right,3=lower-left,4=left,5=upper-left,6=upper-right
def buildB(gap, sw, active_idxs, R=24, cx=80, cy=80):
    cs=cluster(cx,cy,R,gap)
    out=[]
    for i in range(1,7):
        x,y=cs[i]
        fill = '#F7A823' if i in active_idxs else 'none'
        fo = ' fill-opacity="0.16"' if i in active_idxs else ''
        out.append(f'<path d="{path(hexp(x,y,R))}" fill="{fill}"{fo} stroke="#F7A823" stroke-width="{sw}" stroke-linejoin="round"/>')
    ring="".join(out)
    cxp,cyp=cs[0]
    center=f'<path d="{path(hexp(cxp,cyp,R))}" fill="url(#bg)" stroke="#FFD27A" stroke-width="1.6" stroke-linejoin="round"/>'
    return ring, center

defs='<defs><linearGradient id="bg" x1="80" y1="56" x2="80" y2="104" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFC75A"/><stop offset="1" stop-color="#E0860C"/></linearGradient></defs>'

# Take 1: clean tight comb
r,c=buildB(gap=1.2, sw=5, active_idxs=[])
open("B1-clean-mark.svg","w").write(f'<svg width="160" height="160" viewBox="0 0 160 160" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Honeycomb">{defs}{r}{c}</svg>\n')

# Take 2: active memory cells (two diagonal outer cells lit)
r,c=buildB(gap=1.2, sw=5, active_idxs=[6,3])
open("B2-active-mark.svg","w").write(f'<svg width="160" height="160" viewBox="0 0 160 160" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Honeycomb">{defs}{r}{c}</svg>\n')

# Take 3: bolder, slightly bigger center via thicker rim + heavier outer stroke
r,c=buildB(gap=0.6, sw=6.5, active_idxs=[])
open("B3-bold-mark.svg","w").write(f'<svg width="160" height="160" viewBox="0 0 160 160" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Honeycomb">{defs}{r}{c}</svg>\n')
print("built B1 B2 B3")
