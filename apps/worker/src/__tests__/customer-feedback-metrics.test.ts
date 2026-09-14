import { expect, it } from "vitest";
import { measureCustomerFeedback } from "../evaluation/customer-feedback";

it("uses snapshot intervals and verdicts together even when accepted and rejected rows are reversed", () => {
  const feedback = [
    { verdict: "AS_IS", snapshot: { startTime: 40, endTime: 60 } },
    { verdict: "NO", snapshot: { startTime: 10, endTime: 20 } },
  ];
  const result = measureCustomerFeedback([{ start: 10, end: 20 }], feedback);
  expect(result).toMatchObject({ accepted: 1, acceptedCovered: 0, rejected: 1, rejectedRepeated: 1, editRequested: 0 });
  expect(measureCustomerFeedback([{ start: 10, end: 20 }], [...feedback].reverse())).toEqual(result);
  expect(measureCustomerFeedback([{ start: 40, end: 60 }, { start: 10, end: 20 }], feedback))
    .toMatchObject({ acceptedCovered: 1, rejectedRepeated: 1 });
});

it("does not infer approval from EDIT or a partly covered approved episode", () => {
  expect(measureCustomerFeedback([{ start: 12, end: 20 }], [
    { verdict: "AS_IS", snapshot: { startTime: 10, endTime: 20 } },
    { verdict: "EDIT", snapshot: { startTime: 12, endTime: 20 } },
  ])).toMatchObject({ acceptedCovered: 0, editRequested: 1, rejected: 0 });
});

it("refuses missing snapshots rather than silently substituting current clip rows", () => {
  expect(() => measureCustomerFeedback([], [{ verdict: "AS_IS" }])).toThrow(/snapshot/);
  expect(() => measureCustomerFeedback([], [{ verdict: "YES", snapshot: { startTime: 1, endTime: 2 } }])).toThrow(/verdict/);
});


it("deduplicates identical feedback without hiding conflicting verdicts", () => {
  const accepted = { verdict: "AS_IS", snapshot: { startTime: 10, endTime: 20 } };
  expect(measureCustomerFeedback([{ start: 10, end: 20 }], [accepted, structuredClone(accepted), { ...accepted, verdict: "NO" }]))
    .toMatchObject({ accepted: 1, acceptedCovered: 1, rejected: 1, rejectedRepeated: 1 });
});

it("tolerates sub-millisecond serialization changes without treating a shifted rejection as identical", () => {
  const feedback = [{ verdict: "NO", snapshot: { startTime: 10, endTime: 20 } }];
  expect(measureCustomerFeedback([{ start: 10.0005, end: 20.0005 }], feedback).rejectedRepeated).toBe(1);
  expect(measureCustomerFeedback([{ start: 10.002, end: 20.002 }], feedback).rejectedRepeated).toBe(0);
});
