import math, os
from PIL import Image, ImageDraw
OUT = os.path.dirname(os.path.abspath(__file__)).replace("mockup", "brand")
CLAY=(176,86,58); CREAM=(251,250,247); SS=4
VS=[("E 缺口-70°",-70,30,88,26),("F 缺口-55°",-55,30,88,26),("G 缺口-35°",-35,28,88,26),("H 缺口-90° 粒偏移",-90,30,88,26)]
def rnd(size,gc,gh,drad,dr):
    big=size*SS; s=big/512.0; r=148*s; w=36*s; d2=dr*s; rad=drad*s
    img=Image.new("RGBA",(big,big),CLAY+(255,)); d=ImageDraw.Draw(img)
    br=r+w/2
    d.arc([big/2-br,big/2-br,big/2+br,big/2+br],start=gc+gh,end=gc-gh+360,fill=CREAM+(255,),width=int(round(w)))
    a=math.radians(gc); px,py=big/2+rad*math.cos(a),big/2+rad*math.sin(a)
    d.ellipse([px-d2,py-d2,px+d2,py+d2],fill=CREAM+(255,))
    return img.resize((size,size),Image.LANCZOS)
c=Image.new("RGBA",(1240,560),(21,20,19,255)); x=30
for lb,gc,gh,drad,dr in VS:
    c.alpha_composite(rnd(240,gc,gh,drad,dr),(x,40))
    for i,sz in enumerate([64,32]): c.alpha_composite(rnd(sz,gc,gh,drad,dr),(x+40+i*90,310))
    x+=300
c.save(os.path.join(OUT,"candidates.png")); print("ok")
