import {expect,it} from 'vitest';
import {appendSupplementalClips} from '../analyze-v2/supplemental';
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
