# Hero intro

The 13.7 s intro that plays before the speed replay in nekkoagent.com's hero.
Fonts in `public/fonts` are copies of `apps/website/fonts` (OFL-1.1).

    npm install
    npx remotion render src/index.tsx HeroIntro-dark out/intro-dark.mov --codec=prores --prores-profile=hq
    npx remotion render src/index.tsx HeroIntro-light out/intro-light.mov --codec=prores --prores-profile=hq

Then join each with the replay and encode once:

    ffmpeg -i out/intro-dark.mov -i <replay-dark.mp4> -filter_complex "[0:v]format=yuv420p,setsar=1[a];[1:v]format=yuv420p,setsar=1[b];[a][b]concat=n=2:v=1:a=0,fps=30[v]" -map "[v]" -an -c:v libx264 -preset veryslow -crf 22 -tune animation -pix_fmt yuv420p -movflags +faststart ../../apps/website/media/hero-v2.mp4

The replay files (`nekko-vs-ollama-{dark,light}.mp4`) are in git history before this change.
Posters: the frame at 3.5 s, `-c:v libwebp -quality 82`.
