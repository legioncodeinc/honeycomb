import math
def hexF(cx,cy,R,p=2):  # flat-top
    return [(round(cx+R*math.cos(math.radians(a)),p),round(cy+R*math.sin(math.radians(a)),p)) for a in [0,60,120,180,240,300]]
def hexP(cx,cy,R,p=2):  # pointy-top
    return [(round(cx+R*math.cos(math.radians(a)),p),round(cy+R*math.sin(math.radians(a)),p)) for a in [-90,-30,30,90,150,210]]
def path(pts):
    return "M "+" L ".join(f"{x} {y}" for x,y in pts)+" Z"
def cluster(cx,cy,R,gap):
    d=math.sqrt(3)*R+gap
    cs=[(cx,cy)]
    for a in [0,60,120,180,240,300]:
        cs.append((cx+d*math.cos(math.radians(a)), cy+d*math.sin(math.radians(a))))
    return cs

defs='<defs><linearGradient id="bg" x1="80" y1="54" x2="80" y2="106" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFCB63"/><stop offset="0.55" stop-color="#F7A823"/><stop offset="1" stop-color="#DB7F08"/></linearGradient></defs>'

def mark(cx=80,cy=80,R=24,gap=1.0,sw=5.5):
    cs=cluster(cx,cy,R,gap)
    out=[]
    for i in range(1,7):
        x,y=cs[i]
        out.append(f'<path d="{path(hexF(x,y,R))}" fill="none" stroke="#F7A823" stroke-width="{sw}" stroke-linejoin="round"/>')
    ring="".join(out)
    x,y=cs[0]
    center=f'<path d="{path(hexF(x,y,R))}" fill="url(#bg)" stroke="#FFD98A" stroke-width="1.6" stroke-linejoin="round"/>'
    return ring+center

open("B-final-mark.svg","w").write(
 f'<svg width="160" height="160" viewBox="0 0 160 160" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Honeycomb">{defs}{mark()}</svg>\n')

# favicon: single pointy-top filled cell (brand-consistent), gradient + rim, inside thin hex ring for identity
fdefs='<defs><linearGradient id="fg" x1="80" y1="30" x2="80" y2="130" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFCB63"/><stop offset="0.55" stop-color="#F7A823"/><stop offset="1" stop-color="#DB7F08"/></linearGradient></defs>'
fav=(f'<path d="{path(hexP(80,80,60))}" fill="none" stroke="#F7A823" stroke-width="9" stroke-linejoin="round"/>'
     f'<path d="{path(hexP(80,80,30))}" fill="url(#fg)" stroke="#FFD98A" stroke-width="2" stroke-linejoin="round"/>')
open("B-final-favicon.svg","w").write(
 f'<svg width="160" height="160" viewBox="0 0 160 160" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Honeycomb">{fdefs}{fav}</svg>\n')

# monochrome (single-color) cluster for one-color contexts
def mono(color):
    cs=cluster(80,80,24,1.0)
    out=[f'<path d="{path(hexF(*cs[i],24))}" fill="none" stroke="{color}" stroke-width="5.5" stroke-linejoin="round"/>' for i in range(1,7)]
    out.append(f'<path d="{path(hexF(*cs[0],24))}" fill="{color}"/>')
    return "".join(out)
open("B-final-mono.svg","w").write(
 f'<svg width="160" height="160" viewBox="0 0 160 160" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Honeycomb">{mono("#F7A823")}</svg>\n')

# wordmark
wdefs='<defs><linearGradient id="wg" x1="40" y1="28" x2="40" y2="52" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFCB63"/><stop offset="0.55" stop-color="#F7A823"/><stop offset="1" stop-color="#DB7F08"/></linearGradient></defs>'
cs=cluster(40,40,10.5,0.5)
wm=[f'<path d="{path(hexF(*cs[i],10.5))}" fill="none" stroke="#F7A823" stroke-width="2.6" stroke-linejoin="round"/>' for i in range(1,7)]
wm.append(f'<path d="{path(hexF(*cs[0],10.5))}" fill="url(#wg)" stroke="#FFD98A" stroke-width="0.9" stroke-linejoin="round"/>')
text='<text x="92" y="51" font-family="Inter, system-ui, sans-serif" font-size="34" font-weight="700" letter-spacing="-1" fill="#F7F3EC">honeycomb</text>'
open("B-final-wordmark.svg","w").write(
 f'<svg width="340" height="80" viewBox="0 0 340 80" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Honeycomb">{wdefs}{"".join(wm)}{text}</svg>\n')
print("wrote B-final mark, favicon, mono, wordmark")
