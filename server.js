require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const POLLINATIONS_KEY = process.env.POLLINATIONS_API_KEY || '';

const jobs = {};

function newJob() {
  const id = uuidv4();
  jobs[id] = { id, status: 'queued', progress: 0, log: [], videoUrl: null, error: null };
  return jobs[id];
}

function log(job, msg) {
  console.log(`[${job.id}] ${msg}`);
  job.log.push(msg);
  if (job.log.length > 200) job.log.shift();
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(-800)}`));
    });
    proc.on('error', reject);
  });
}

async function getAudioDuration(filePath) {
  const out = await runCmd(ffprobePath, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filePath
  ]);
  const dur = parseFloat(out.trim());
  return isNaN(dur) ? 4 : dur;
}

async function breakdownStory(story) {
  const systemPrompt = `You are a film storyboard assistant. Break the given story or idea into 6-10 concise cinematic scenes for a short narrated video.
Respond ONLY with a JSON array, no preamble, no markdown fences. Each item must have exactly these fields:
- "image_prompt": a vivid, concrete visual description for an image generator (max 25 words, no text/words in the image)
- "narration": a short voiceover line for this scene, natural spoken English (max 30 words)
- "movement": one of "zoom_in", "zoom_out", "pan_left", "pan_right", "static"
Return valid JSON only, nothing else.`;

  const res = await fetch('https://gen.pollinations.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${POLLINATIONS_KEY}`
    },
    body: JSON.stringify({
      model: 'openai',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: story }
      ]
    })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Scene breakdown API error ${res.status}: ${t.slice(0, 300)}`);
  }

  const data = await res.json();
  let text = '';
  if (data.choices && data.choices[0] && data.choices[0].message) {
    text = data.choices[0].message.content || '';
  } else if (typeof data === 'string') {
    text = data;
  } else {
    text = JSON.stringify(data);
  }

  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    text = text.slice(firstBracket, lastBracket + 1);
  }

  const scenes = JSON.parse(text);
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error('Scene breakdown did not return a valid list of scenes.');
  }
  return scenes;
}

async function generateImage(prompt, outPath) {
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=flux&width=1920&height=1080&seed=${seed}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${POLLINATIONS_KEY}` }
  });
  if (!res.ok) throw new Error(`Image API error ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

async function generateAudio(text, outPath) {
  if (!POLLINATIONS_KEY) {
    throw new Error('Missing POLLINATIONS_API_KEY. Get a free key at https://enter.pollinations.ai and set it as an environment variable.');
  }
  const res = await fetch('https://gen.pollinations.ai/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${POLLINATIONS_KEY}`
    },
    body: JSON.stringify({ model: 'tts-1', input: text, voice: 'alloy' })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`TTS API error ${res.status}: ${t.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

function buildZoompanFilter(movement, frames, w = 1920, h = 1080) {
  const base = `scale=${w * 2}:-1,setsar=1`;
  switch (movement) {
    case 'zoom_in':
      return `${base},zoompan=z='min(zoom+0.0020,1.4)':d=${frames}:s=${w}x${h}:fps=30`;
    case 'zoom_out':
      return `${base},zoompan=z='min(zoom+0.0020,1.4)':d=${frames}:s=${w}x${h}:fps=30,reverse`;
    case 'pan_left':
      return `${base},zoompan=z='1.18':x='(iw-iw/zoom)*(1-on/${frames})':y='(ih-ih/zoom)/2':d=${frames}:s=${w}x${h}:fps=30`;
    case 'pan_right':
      return `${base},zoompan=z='1.18':x='(iw-iw/zoom)*(on/${frames})':y='(ih-ih/zoom)/2':d=${frames}:s=${w}x${h}:fps=30`;
    default:
      return `${base},zoompan=z='1.08':d=${frames}:s=${w}x${h}:fps=30`;
  }
}

async function buildSceneClip(imagePath, audioPath, movement, outPath) {
  const duration = await getAudioDuration(audioPath);
  const frames = Math.max(30, Math.round(duration * 30));
  const filter = buildZoompanFilter(movement, frames);

  const args = [
    '-y', '-loop', '1', '-i', imagePath, '-i', audioPath,
    '-filter_complex', `[0:v]${filter}[v]`,
    '-map', '[v]', '-map', '1:a',
    '-t', duration.toFixed(2),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', outPath
  ];
  await runCmd(ffmpegPath, args);
}

async function concatClips(clipPaths, listPath, outPath) {
  const listContent = clipPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listPath, listContent);
  await runCmd(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
}

async function processJob(job, story) {
  try {
    const workDir = path.join(os.tmpdir(), 'storyvideo', job.id);
    fs.mkdirSync(workDir, { recursive: true });

    job.status = 'breaking_down';
    log(job, 'Breaking story into scenes...');
    const scenes = await breakdownStory(story);
    job.progress = 10;
    log(job, `Got ${scenes.length} scenes.`);

    const clipPaths = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      job.status = 'generating_images';
      log(job, `Scene ${i + 1}/${scenes.length}: generating image...`);
      const imgPath = path.join(workDir, `image_${i}.jpg`);
      await generateImage(scene.image_prompt, imgPath);
      job.progress = 10 + Math.round((i / scenes.length) * 30);

      job.status = 'generating_audio';
      log(job, `Scene ${i + 1}/${scenes.length}: generating narration...`);
      const audPath = path.join(workDir, `audio_${i}.mp3`);
      await generateAudio(scene.narration, audPath);
      job.progress = 40 + Math.round((i / scenes.length) * 30);

      job.status = 'assembling';
      log(job, `Scene ${i + 1}/${scenes.length}: building clip...`);
      const clipPath = path.join(workDir, `clip_${i}.mp4`);
      await buildSceneClip(imgPath, audPath, scene.movement, clipPath);
      clipPaths.push(clipPath);
      job.progress = 70 + Math.round((i / scenes.length) * 20);
    }

    job.status = 'assembling';
    log(job, 'Stitching all scenes into the final video...');
    const listPath = path.join(workDir, 'list.txt');
    const outputDir = path.join(__dirname, 'public', 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const finalPath = path.join(outputDir, `${job.id}.mp4`);
    await concatClips(clipPaths, listPath, finalPath);

    job.progress = 100;
    job.status = 'done';
    job.videoUrl = `/output/${job.id}.mp4`;
    log(job, 'Done! Video is ready.');
  } catch (err) {
    console.error(err);
    job.status = 'error';
    job.error = err.message || String(err);
    log(job, `ERROR: ${job.error}`);
  }
}

app.post('/api/generate', (req, res) => {
  const story = (req.body.story || '').trim();
  if (!story) return res.status(400).json({ error: 'Story text is required.' });
  const job = newJob();
  processJob(job, story);
  res.json({ jobId: job.id });
});

app.get('/api/status/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json(job);
});

app.listen(PORT, () => {
  console.log(`StoryVideo app running on port ${PORT}`);
});
  

  
