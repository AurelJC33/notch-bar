#!/usr/bin/env python3
"""Génère les effets sonores du notch et les embarque dans renderer/sound-assets.js.

Pourquoi embarqués en base64 : la CSP du renderer (connect-src restreint) interdit
fetch/XHR vers les fichiers locaux. Un <script> 'self' est le chemin le plus sûr.
Les .wav sont aussi écrits dans renderer/sounds/ pour pouvoir les écouter/remplacer.

Identité sonore : un seul timbre (sinus + 2e harmonique discrète, attaque rapide,
décroissance exponentielle). Seules les hauteurs et le nombre de notes changent :
montant = connexion / fin de focus, descendant = déconnexion / fin de pause.
"""
import base64, json, os, struct, wave
import numpy as np

SR = 22050
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_WAV = os.path.join(ROOT, 'renderer', 'sounds')
OUT_JS = os.path.join(ROOT, 'renderer', 'sound-assets.js')

NOTE = {'C5': 523.25, 'E5': 659.25, 'G5': 783.99, 'A5': 880.00, 'B5': 987.77, 'C6': 1046.50, 'E6': 1318.51}

def tone(freq, dur, decay=7.0, harmonic=0.18, peak=0.5):
    t = np.arange(int(SR * dur)) / SR
    wave_ = np.sin(2 * np.pi * freq * t) + harmonic * np.sin(4 * np.pi * freq * t)
    attack = np.minimum(1.0, t / 0.004)              # 4 ms : pas de clic
    env = attack * np.exp(-decay * t / dur)
    fade = np.minimum(1.0, (dur - t) / 0.012)         # fondu de fin
    sig = wave_ * env * np.clip(fade, 0, 1)
    return sig / max(1e-9, np.max(np.abs(sig))) * peak

def sequence(notes, gap=0.0, **kw):
    parts = []
    for name, dur in notes:
        parts.append(tone(NOTE[name], dur, **kw))
        if gap: parts.append(np.zeros(int(SR * gap)))
    return np.concatenate(parts)

def overlay(notes, step, dur, **kw):
    total = int(SR * (step * (len(notes) - 1) + dur))
    out = np.zeros(total)
    for i, name in enumerate(notes):
        s = tone(NOTE[name], dur, **kw)
        start = int(SR * step * i)
        out[start:start + len(s)] += s
    return out / max(1.0, np.max(np.abs(out))) * 0.5

SOUNDS = {
    # interface : ~45 ms, très doux (le volume global le réduit encore)
    'tick':         tone(1400, 0.05, decay=9, harmonic=0.0, peak=0.35),
    # notifications
    'reminder':     sequence([('A5', 0.11), ('A5', 0.11)], gap=0.03, decay=6),
    'connect':      overlay(['E5', 'B5'], 0.09, 0.19, decay=6),   # montant
    'disconnect':   overlay(['B5', 'E5'], 0.09, 0.19, decay=6),   # descendant
    # minuteurs
    'timerDone':    overlay(['C5', 'E5', 'G5'], 0.07, 0.16, decay=5),
    'pomoFocusEnd': overlay(['E5', 'G5', 'C6'], 0.07, 0.16, decay=5),     # montant : pause méritée
    'pomoBreakEnd': overlay(['G5', 'E5'], 0.08, 0.20, decay=5),          # descendant : retour au focus
    # mise à jour disponible : même timbre doux et montant que « connect » (remplace-le ici pour changer de son)
    'updateAvailable': overlay(['E5', 'B5'], 0.09, 0.19, decay=6),
}

def to_pcm16(sig):
    return (np.clip(sig, -1, 1) * 32767).astype('<i2').tobytes()

os.makedirs(OUT_WAV, exist_ok=True)
assets = {}
for name, sig in SOUNDS.items():
    pcm = to_pcm16(sig)
    path = os.path.join(OUT_WAV, f'{name}.wav')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm)
    with open(path, 'rb') as f:
        assets[name] = base64.b64encode(f.read()).decode('ascii')
    print(f'{name:14s} {len(sig)/SR*1000:5.0f} ms  {os.path.getsize(path):6d} octets')

with open(OUT_JS, 'w') as f:
    f.write('/* Fichier généré par tools/generate-sounds.py — ne pas éditer à la main. */\n')
    f.write('window.NOTCH_SOUND_ASSETS = ' + json.dumps(assets, indent=2) + ';\n')
print('->', OUT_JS, os.path.getsize(OUT_JS), 'octets')
