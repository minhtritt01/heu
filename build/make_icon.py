# Vẽ icon app (chạy trong GitHub Actions trước khi đóng gói)
from PIL import Image, ImageDraw, ImageFont
import os
S = 1024
im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
grad = Image.new('RGBA', (S, S))
d = ImageDraw.Draw(grad)
for y in range(S):
    t = y / S
    d.line([(0, y), (S, y)], fill=(int(181 * (1 - t) + 63 * t), int(244 * (1 - t) + 179 * t), int(92 * (1 - t) + 127 * t), 255))
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=220, fill=255)
im.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(im)
font = None
for f in ['C:/Windows/Fonts/arialbd.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']:
    if os.path.exists(f):
        font = ImageFont.truetype(f, 330)
        break
bb = d.textbbox((0, 0), 'HÊU', font=font)
d.text(((S - (bb[2] - bb[0])) / 2 - bb[0], (S - (bb[3] - bb[1])) / 2 - bb[1] - 20), 'HÊU', font=font, fill=(16, 32, 10, 255))
d.polygon([(700, 700), (700, 860), (840, 780)], fill=(16, 32, 10, 255))
os.makedirs('build', exist_ok=True)
im.resize((512, 512), Image.LANCZOS).save('build/icon.png')
print('icon ok')
