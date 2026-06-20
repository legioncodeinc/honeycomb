import math
def hexp(cx,cy,R,flat=False,p=1):
    angs=[0,60,120,180,240,300] if flat else [-90,-30,30,90,150,210]
    return [(round(cx+R*math.cos(math.radians(a)),p),round(cy+R*math.sin(math.radians(a)),p)) for a in angs]
def path(pts):
    return "M "+" L ".join(f"{x} {y}" for x,y in pts)+" Z"
# wordmark mark sits left, centered vertically at y=40, scaled mark
# A refined cell small: center (40,40)
def A():
    o=path(hexp(40,40,28))
    inr=path(hexp(40,40,11))
    return f'<path d="{o}" fill="none" stroke="#F7A823" stroke-width="4" stroke-linejoin="round"/><path d="{inr}" fill="url(#wA)" stroke="#FFD27A" stroke-width="0.8" stroke-linejoin="round"/>'
# B cluster small center (40,40) R=10 flat, gap
def B():
    d=math.sqrt(3)*10+0.8
    out=[]
    for a in [0,60,120,180,240,300]:
        cx=40+d*math.cos(math.radians(a)); cy=40+d*math.sin(math.radians(a))
        out.append(f'<path d="{path(hexp(cx,cy,10,flat=True))}" fill="none" stroke="#F7A823" stroke-width="2.4" stroke-opacity="0.85" stroke-linejoin="round"/>')
    center=f'<path d="{path(hexp(40,40,10,flat=True))}" fill="url(#wA)" stroke="#FFD27A" stroke-width="0.8" stroke-linejoin="round"/>'
    return "".join(out)+center
def C():
    a=path(hexp(40,40,28)); b=path(hexp(40,40,19)); c=path(hexp(40,40,10))
    return (f'<path d="{a}" fill="none" stroke="#F7A823" stroke-width="4" stroke-linejoin="round"/>'
            f'<path d="{b}" fill="none" stroke="#F7A823" stroke-width="2.4" stroke-opacity="0.6" stroke-linejoin="round"/>'
            f'<path d="{c}" fill="url(#wA)" stroke="#FFD27A" stroke-width="0.8" stroke-linejoin="round"/>')
def D():
    verts=hexp(40,40,11)
    spokes="".join(f'<path d="M40 40 L{x} {y}"/>' for x,y in verts)
    nodes="".join(f'<circle cx="{x}" cy="{y}" r="2.4"/>' for x,y in verts)
    o=path(hexp(40,40,28))
    return (f'<path d="{o}" fill="none" stroke="#F7A823" stroke-width="4" stroke-linejoin="round"/>'
            f'<g stroke="#F7A823" stroke-width="1.3" stroke-opacity="0.55" stroke-linecap="round">{spokes}</g>'
            f'<g fill="#F7A823">{nodes}</g>'
            f'<circle cx="40" cy="40" r="5" fill="url(#wA)" stroke="#FFD27A" stroke-width="0.8"/>')

defs='<defs><linearGradient id="wA" x1="40" y1="29" x2="40" y2="51" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFC04D"/><stop offset="1" stop-color="#E0860C"/></linearGradient></defs>'
text='<text x="92" y="51" font-family="Inter, system-ui, sans-serif" font-size="34" font-weight="700" letter-spacing="-1" fill="#F7F3EC">honeycomb</text>'

for name,fn in [("A-refined-cell",A),("B-memory-cluster",B),("C-nested-layers",C),("D-vector-nodes",D)]:
    svg=f'<svg width="340" height="80" viewBox="0 0 340 80" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Honeycomb">{defs}{fn()}{text}</svg>\n'
    open(f"{name}-wordmark.svg","w").write(svg)
    print("wrote",name)
