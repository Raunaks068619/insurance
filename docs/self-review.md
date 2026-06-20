## The strongest part
- The strongest part of the system was the pure adjudication pipeline. During the research of the insurance domain, I got to know a lot about the insurance domain, which was how the connection between policy member and claim works, what is the policy lifecycle, claim processing system lifecycle, and multiple Attributes like coverage rules of the policy, what is excluded and included in the policy, what are line items, what is preauth, why prior authorization is required for some cases in the claim. For example, MRI needs a preauthorization in order to be claimed. What are the deductibles From a particular policy, what is co-pay, co-insurance. Also, how the annual limit works. Also, the state management, basically accumulator. How does out-of-pocket system works when the user pays the bill themselves and then claim. So, these are the things I got to know.

- Then put all these business rules  rules  understood  I  into adjudication  adjudication  an ordered sequence , basically  sequence  detection , detection , checking , policy , pre  pre   , auth , limited  limited reinforcements , reinforcements  sharing , sharing  calculation , calculation , out pocket , pocket  , cap , handling , handling .I chose this , this workflow because  because it produces an produces an outcome .

- Why do I trust this more? Because it is implemented as a pure function and it is not dependent on the request call, database, or other code. Also, I have a growing suite of domain-focused tests that validate both approval and denial paths, giving me confidence that the code and insurance logic behave correctly

- Caught the duplication logic bug. In this code, previously it was used to take two claims and was not able to detect; the check was not there if a particular line item is being duplicated or not. So I have fixed that as well.

- Caught and closed a PHI gap. The four sensitive columns (`members.name`/`dob`, `claims.provider`/`diagnosis_code`) were only *labelled* "encrypted at rest" but actually stored as plain text — a claim the bytes on disk didn't back. They are now genuinely encrypted with AES-256-GCM (random IV + auth tag per value) via `app/src/db/phi-crypto.ts`, applied at a single repository seam (encrypt on write, decrypt on read), with the key in `.env` (`PHI_ENCRYPTION_KEY`). Proven by `app/tests/phi-encryption.test.ts`: ciphertext at rest, round-trip decrypt, and tamper rejection. SQLCipher whole-file encryption remains the production-scale alternative.


## Your best judgment call
- I chose full coverage , copay and coinsurance as a typed union over a copay and coinsurance that might be nullable or a rules DSL that I got recommended when trying tho understand the coverage ruels

- I also chose a unit type limit over a dollar-only cap because the domain needs both a dollar and visit limit, and the system should make that decision impossible to ignore. Because not all insurance or policies are only dollar or money limited. It can also be visit limited.


## Whats rough
- The roughest part is the dispute flow. It works, but it is the most complex path because it reopens one line, re-adjudicates with corrected facts, net-outs the old accumulator impact, and re-aggregates the claim in one transaction. It is solid for v1, but I would not call it the cleanest or most battle-tested part yet and would like to learn and ideat more on this part 


## Whats thin / skipped
- The roughest part I actually shipped is the dispute flow. It works, but it is the least polished path because it reopens a single line item, re-adjudicates it with corrected facts, net-outs only that line’s accumulator impact, and then re-aggregates the claim in one transaction. It is solid for v1, but I would not call it fully tested yet.

- skipped pre-auth as the workflow currently it sits as a flag in the input, a payment flow for pid or settled state.


# Confidance
- I have the highest confidence in the adjudication engine because it is deterministic, heavily tested, and isolated from infrastructure. My lowest confidence areas are dispute complexity and production-scale concerns such as concurrency, fee schedules, and settlement workflows.

- I have the biggest confidence in the aggregation pipeline because it determines that its tested and isolated from the whole infrastructure. My least confident area would be the dispute complexity. I have also skipped the settlement workflow and fee schedule as well


# With more time
- With more time, I would add a stronger dispute workflow and exhaustive accumulator and clean testing. I would also like to add an out-of-network coverage response and a UI for this. Improve the explanation area by adding an explanation API. And I would strengthen the personal health data as well.


# summary
- I think the system that I've created with the domain research does a good job modeling the insurance domain, keeping the adjudication logic deterministic, explainable, and heavily testable. The strongest area is the adjudication engine, which cleanly captures the coverage rules, limits, cost share, and accumulation. The weakest area is also the dispute workflow and And some production-level concerns like scheduling, security, or concurrency, multiple edge cases. This assignment gave me a chance to understand how difficult it is to understand a system that's not from my domain and how planning it properly is very important. I've reflected on myself during this time. I thank you very much for giving me such a great assignment to do. This was a very different experience for me. The domain research part helped me a lot to understand how I look at certain problems. As a developer who can work with a feature end-to-end, but when told to start understanding a whole new system and work on it, I was pretty confused, but with enough questions i got answerd i have a a basic understanding of the project and the role this was a greate expreince.