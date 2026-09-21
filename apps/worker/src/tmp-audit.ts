import { PrismaClient } from '@prisma/client';
type Cue = { text: string; start: number; end: number };
const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();

(async () => {
  const p = new PrismaClient();
  const since = new Date(Date.now() - 14*24*3600*1000);
  const clips = await p.clip.findMany({
    where: { createdAt: { gte: since } },
    select: { id:true, jobId:true, startTime:true, endTime:true, title:true, subtitleTrack:true, createdAt:true },
    orderBy: [{ jobId:'asc' }, { startTime:'asc' } ],
  });
  const byJob = new Map<string, typeof clips>();
  for (const c of clips) { const a = byJob.get(c.jobId) ?? []; a.push(c); byJob.set(c.jobId, a); }

  let total=0, startsAtZero=0, overlapPairs=0, sharedTail=0, shortDur=0, longDur=0, noCues=0;
  const examples: string[] = [];
  for (const [jobId, list] of byJob) {
    for (let i=0;i<list.length;i++){
      const c = list[i]; total++;
      const dur = c.endTime - c.startTime;
      if (c.startTime < 0.5) startsAtZero++;
      if (dur < 12) shortDur++;
      if (dur > 70) longDur++;
      const cues = ((c.subtitleTrack as any)?.cues ?? []) as Cue[];
      if (!cues.length) { noCues++; continue; }
      const next = list[i+1];
      if (next && next.startTime < c.endTime) {
        overlapPairs++;
        const nextCues = ((next.subtitleTrack as any)?.cues ?? []) as Cue[];
        const tail = cues.slice(-6).map(x=>norm(x.text)).join(' ');
        const head = nextCues.slice(0,6).map(x=>norm(x.text)).join(' ');
        if (tail && head && (tail.includes(head.slice(0,25)) || head.includes(tail.slice(0,25)))) {
          sharedTail++;
          if (examples.length<4) examples.push(`job ${jobId.slice(-6)}: ${c.startTime.toFixed(0)}-${c.endTime.toFixed(0)} shares tail with ${next.startTime.toFixed(0)}-${next.endTime.toFixed(0)} :: "${head.slice(0,60)}"`);
        }
      }
    }
  }
  console.log('clips (14d):', total, '| jobs:', byJob.size);
  console.log('start at 0.0s (source intro):', startsAtZero);
  console.log('overlapping sibling pairs   :', overlapPairs);
  console.log('  of which SHARE the tail   :', sharedTail);
  console.log('duration < 12s              :', shortDur);
  console.log('duration > 70s              :', longDur);
  console.log('no subtitle cues            :', noCues);
  for (const e of examples) console.log('  ex:', e);
  await p.$disconnect();
})();
