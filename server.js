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
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

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
  const url = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=flux&width=1280&height=720&seed=${seed}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${POLLINATIONS_KEY}` }
  });
  if (!res.ok) throw new Error(`Image API error ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

function pcmToWav(pcmBuffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let lastTTSCallAt = 0;
async function waitForTTSRateLimit() {
  const minGapMs = 31000;
  const elapsed = Date.now() - lastTTSCallAt;
  if (lastTTSCallAt > 0 && elapsed < minGapMs) {
    await sleep(minGapMs - elapsed);
  }
  lastTTSCallAt = Date.now();
}

async function generateBatchAudio(texts, outPath) {
  if (!GEMINI_KEY) {
    throw new Error('Missing GEMINI_API_KEY. Get a free key at https://aistudio.google.com/apikey and set it as an environment variable.');
  }
  await waitForTTSRateLimit();

  const combinedText = texts.join('. ... ');

  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_KEY
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: combinedText }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
        }
      })
    }
  );

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`TTS API error ${res.status}: ${t.slice(0, 300)}`);
  }

  const data = await res.json();
  const part = data.candidates?.[0]?.content?.parts?.[0];
  if (!part || !part.inlineData || !part.inlineData.data) {
    throw new Error('TTS response did not contain audio data.');
  }

  const mimeType = part.inlineData.mimeType || '';
  const rateMatch = mimeType.match(/rate=(\d+)/);
  const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;

  const pcmBuffer = Buffer.from(part.inlineData.data, 'base64');
  const wavBuffer = pcmToWav(pcmBuffer, sampleRate);
  fs.writeFileSync(outPath, wavBuffer);
}

async function splitBatchAudio(batchAudioPath, texts, workDir, batchIndex) {
  const totalDuration = await getAudioDuration(batchAudioPath);
  const totalChars = texts.reduce((sum, t) => sum + t.length, 0) || 1;

  const outPaths = [];
  let cursor = 0;
  for (let i = 0; i < texts.length; i++) {
    const share = texts[i].length / totalChars;
    const segDuration = Math.max(0.6, totalDuration * share);
    const outPath = path.join(workDir, `audio_${batchIndex}_${i}.wav`);
    const args = [
      '-y', '-i', batchAudioPath,
      '-ss', cursor.toFixed(2),
      '-t', segDuration.toFixed(2),
      '-acodec', 'pcm_s16le',
      outPath
    ];
    await runCmd(ffmpegPath, args);
    outPaths.push(outPath);
    cursor += segDuration;
  }
  return outPaths;
}

function buildZoompanFilter(movement, frames, w = 1280, h = 720) {
  const base = `scale=${Math.round(w * 1.3)}:-1,setsar=1`;
  switch (movement) {
    case 'zoom_in':
      return `${base},zoompan=z='min(zoom+0.0020,1.4)':d=${frames}:s=${w}x${h}:fps=24`;
    case 'zoom_out':
      return `${base},zoompan=z='min(zoom+0.0020,1.4)':d=${frames}:s=${w}x${h}:fps=24,reverse`;
    case 'pan_left':
      return `${base},zoompan=z='1.18':x='(iw-iw/zoom)*(1-on/${frames})':y='(ih-ih/zoom)/2':d=${frames}:s=${w}x${h}:fps=24`;
    case 'pan_right':
      return `${base},zoompan=z='1.18':x='(iw-iw/zoom)*(on/${frames})':y='(ih-ih/zoom)/2':d=${frames}:s=${w}x${h}:fps=24`;
    default:
      return `${base},zoompan=z='1.08':d=${frames}:s=${w}x${h}:fps=24`;
  }
}

async function buildSceneClip(imagePath, audioPath, movement, outPath) {
  const duration = await getAudioDuration(audioPath);
  const frames = Math.max(24, Math.round(duration * 24));
  const filter = buildZoompanFilter(movement, frames);

  const args = [
    '-y', '-loop', '1', '-i', imagePath, '-i', audioPath,
    '-filter_complex', `[0:v]${filter}[v]`,
    '-map', '[v]', '-map', '1:a',
    '-t', duration.toFixed(2),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', outPath
  ];
  await runCmd(ffmpegPath, args);
}

async function concatClips(clipPaths, listPath, outPath) {
  const listContent = clipPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listPath, listContent);
  await runCmd(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
}

const BATCH_SIZE = 5;

async function processJob(job, story) {
  try {
    const workDir = path.join(os.tmpdir(), 'storyvideo', job.id);
    fs.mkdirSync(workDir, { recursive: true });

    job.status = 'breaking_down';
    log(job, 'Breaking story into scenes...');
    const scenes = await breakdownStory(story);
    job.progress = 10;
    log(job, `Got ${scenes.length} scenes.`);

    const imagePaths = [];
    for (let i = 0; i < scenes.length; i++) {
      job.status = 'generating_images';
      log(job, `Scene ${i + 1}/${scenes.length}: generating image...`);
      const imgPath = path.join(workDir, `image_${i}.jpg`);
      await generateImage(scenes[i].image_prompt, imgPath);
      imagePaths.push(imgPath);
      job.progress = 10 + Math.round((i / scenes.length) * 30);
    }

    const numBatches = Math.ceil(scenes.length / BATCH_SIZE);
    const audioPaths = [];
    for (let b = 0; b < numBatches; b++) {
      const batchScenes = scenes.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
      job.status = 'generating_audio';
      log(job, `Narration batch ${b + 1}/${numBatches} (${batchScenes.length} scenes)...`);
      const batchAudioPath = path.join(workDir, `batch_${b}.wav`);
      await generateBatchAudio(batchScenes.map(s => s.narration), batchAudioPath);
      const splitPaths = await splitBatchAudio(batchAudioPath, batchScenes.map(s => s.narration), workDir, b);
      audioPaths.push(...splitPaths);
      job.progress = 40 + Math.round(((b + 1) / numBatches) * 30);
    }

    const clipPaths = [];
    for (let i = 0; i < scenes.length; i++) {
      job.status = 'assembling';
      log(job, `Scene ${i + 1}/${scenes.length}: building clip...`);
      const clipPath = path.join(workDir, `clip_${i}.mp4`);
      await buildSceneClip(imagePaths[i], audioPaths[i], scenes[i].movement, clipPath);
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





  


    
  

  

  

  







  
