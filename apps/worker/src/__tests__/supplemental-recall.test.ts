import {expect,it} from 'vitest';
import {appendSupplementalClips, shouldRunSupplementalRecall, supplementalQualityConfig} from '../analyze-v2/supplemental';
import {loadAnalyzeConfig} from '../analyze-v2/config';

const cleanArc = { entry: { ok: true }, exit: { ok: true }, standalone: { ok: true } };

it('lets the episode-recall lane reach a payoff anywhere inside the normal clip cap',()=>{
 const cfg=loadAnalyzeConfig({END_EXTENSION_WINDOW_SEC:'25',CLIP_MAX_SEC:'90'});
 const widened=supplementalQualityConfig(cfg,'delivered-payoff-medium');
 expect(widened.endExtensionWindowSec).toBe(90);
 expect(widened.reasoningEffort).toBe('medium');
 expect(cfg.endExtensionWindowSec).toBe(25);
});

it('replaces a setup-only teaser with a complete supplemental episode',()=>{
 const teaser={start:0,end:10,score:.72,_arcFlags:{entry:{ok:true},exit:{ok:false,defect:'setup_no_payoff'},standalone:{ok:true}}};
 const other={start:130,end:154,score:.64,_arcFlags:cleanArc};
 const complete={start:0,end:65,score:.68,_arcFlags:cleanArc};
 expect(appendSupplementalClips([teaser,other],[complete],3)).toEqual([complete,other]);
});

it('can repair a setup-only teaser when the primary set is already at the cap',()=>{
 const teaser={start:0,end:10,_arcFlags:{entry:{ok:true},exit:{ok:false,defect:'setup_no_payoff'},standalone:{ok:true}}};
 const other={start:130,end:154,_arcFlags:cleanArc};
 const complete={start:0,end:65,_arcFlags:cleanArc};
 expect(appendSupplementalClips([teaser,other],[complete],2)).toEqual([complete,other]);
 expect(shouldRunSupplementalRecall([teaser,other],2)).toBe(true);
 expect(shouldRunSupplementalRecall([{...teaser,_arcFlags:cleanArc},other],2)).toBe(false);
});

it('does not replace more than one primary clip with a broad supplemental range',()=>{
 const setup=(start:number,end:number)=>({start,end,_arcFlags:{entry:{ok:true},exit:{ok:false,defect:'setup_no_payoff'},standalone:{ok:true}}});
 const primary=[setup(0,10),setup(20,30)];
 expect(appendSupplementalClips(primary,[{start:0,end:40,_arcFlags:cleanArc}],2)).toEqual(primary);
});

it('preserves primary choices and their order even against higher-scored overlapping alternatives',()=>{
 const primary=[{start:30,end:50,score:.6},{start:0,end:20,score:.7}];
 const extras=[{start:32,end:49,score:.99},{start:60,end:80,score:.8},{start:61,end:79,score:.95},{start:90,end:110,score:.9}];
 const result=appendSupplementalClips(primary,extras,3);
 expect(result).toEqual([...primary,extras[1]]);
 expect(result[0]).toBe(primary[0]);expect(result[1]).toBe(primary[1]);
});
it('never evicts primary output at the cap, and can supplement a valid empty result',()=>{
 const primary=[{start:0,end:10},{start:20,end:30}];
 expect(appendSupplementalClips(primary,[{start:40,end:50}],1)).toEqual(primary);
 expect(appendSupplementalClips([],[{start:40,end:50}],1)).toEqual([{start:40,end:50}]);
});

it('rejects a final supplemental cut expanded across missing audio', () => {
  const primary = [{ start: 10, end: 30 }];
  expect(appendSupplementalClips(primary, [{ start: 89.85, end: 129.8 }], 3,
    [{ start: 94.5, end: 105 }])).toEqual(primary);
});

it('does not let a quarantined supplemental replace a primary setup clip', () => {
 const teaser={start:0,end:10,_arcFlags:{entry:{ok:true},exit:{ok:false,defect:'setup_no_payoff'},standalone:{ok:true}}};
 const quarantined={start:0,end:65,_arcFlags:cleanArc,_deliveredPayoffQuarantined:true as const};
 const verified={start:80,end:100,_arcFlags:cleanArc};
 expect(appendSupplementalClips([teaser],[quarantined,verified],2)).toEqual([teaser,verified]);
});
