// Exact published TechlyUp course content snapshot, 2026-10-16. Public text only.
export const courseLessons = [
  {
    "id": "lesson-tcfc-pattern",
    "slug": "why-prompts-fail",
    "courseSlug": "get-useful-answers-from-ai",
    "order": 1,
    "title": "Why most prompts fail — and the 4-part fix",
    "format": "text",
    "readMinutes": 4,
    "body": [
      "Most disappointing AI answers aren't the AI's fault — they're missing information. When you type a one-line question, the AI fills the gaps with guesses. Fix the gaps and most of that guessing disappears — though you should still check the answer, since a clear prompt reduces errors, it doesn't guarantee a correct one.",
      "There's a simple four-part pattern that removes almost all of that guessing: Task, Context, Format, Constraints (TCFC). You say what you want done (Task), what background the AI needs to know (Context), how you want the answer structured (Format), and what to avoid or must include (Constraints).",
      "Compare these two prompts. First: \"Write a follow-up email.\" Second: \"Write a follow-up email to a client who hasn't replied in 5 days about a ₹40,000 invoice. Keep it under 100 words, friendly but firm, no apologies for following up. End with one clear question.\" The second one gets you something usable immediately — because it supplies Context, Constraints, and Format that the first one left the AI to guess.",
      "You don't need all four parts every time. But when an answer disappoints you, it's almost always because one of the four was missing."
    ],
    "tryIt": "Take a question you'd normally ask an AI tool today. Rewrite it using Task + Context + Format + Constraints before you send it. Notice what changes in the answer.",
    "status": "published"
  },
  {
    "id": "lesson-context",
    "slug": "giving-context",
    "courseSlug": "get-useful-answers-from-ai",
    "order": 2,
    "title": "Giving the AI context it doesn't have",
    "format": "text",
    "readMinutes": 4,
    "body": [
      "The AI can't see your inbox, your company, your files, or your history with a client — unless you tell it. This is the single biggest cause of generic, unusable answers.",
      "Three things are almost always worth including: who the audience is, what's already been tried or said, and what the real-world stakes are — is this urgent, sensitive, going to a client versus a teammate.",
      "A trick that works well: paste in the actual material you're working from — an email thread, a paragraph of notes, a table of numbers — rather than describing it from memory. AI tools are much better at working from real text than from your summary of it.",
      "Watch out for one thing: don't paste in information that shouldn't leave your company — client contracts, personal data, anything confidential. If you wouldn't email it to a stranger, don't paste it into a public AI tool."
    ],
    "tryIt": "For your next work question, add one sentence of context you'd normally leave out because it seems 'obvious.' See if the answer gets noticeably more specific.",
    "status": "published"
  },
  {
    "id": "lesson-format",
    "slug": "asking-for-the-right-format",
    "courseSlug": "get-useful-answers-from-ai",
    "order": 3,
    "title": "Asking for the format you actually need",
    "format": "text",
    "readMinutes": 3,
    "body": [
      "If you're going to copy the answer into an email, a table, or a slide, ask for it in that shape from the start — it saves you from reformatting by hand every time.",
      "Useful format requests: \"as a numbered list,\" \"as a table with these columns,\" \"in plain paragraphs, no bullet points,\" \"under 150 words,\" \"as a short email with a subject line.\"",
      "Format requests also control quality indirectly. Asking for \"3 bullet points, each one sentence\" forces the AI to prioritize instead of listing everything it can think of.",
      "If the first answer isn't in a useful shape, you don't need to start over — just reply with \"same content, but as [format].\" That's faster than rewriting the whole prompt."
    ],
    "tryIt": "Ask the same question twice — once with no format instruction, once specifying the exact shape you need. Compare how much editing each answer needs before you could actually use it.",
    "status": "published"
  },
  {
    "id": "lesson-verify",
    "slug": "checking-before-you-trust-it",
    "courseSlug": "get-useful-answers-from-ai",
    "order": 4,
    "title": "Checking an AI answer before you trust it",
    "format": "text",
    "readMinutes": 5,
    "body": [
      "An AI answer that sounds confident is not the same as an AI answer that's correct. This lesson is a short checklist to run before you act on anything an AI gives you for real work.",
      "The rule of thumb: the more consequential the output — money, a client relationship, a legal or medical claim — the more independent verification it needs before you rely on it. AI is a fast first draft, not a substitute for judgment."
    ],
    "checklist": [
      "Numbers and dates: can you verify this specific figure from a source you trust — a document, a website, your own records? If not, treat it as a guess, not a fact.",
      "Names and claims about people or companies: would you be comfortable if this turned out to be wrong and someone asked \"where did you get that\"? If not, verify before using it.",
      "Anything you're about to send externally: read it once as if you were the recipient. Does it sound like something a careful person actually wrote?",
      "If the AI cites a source, check whether that source is real and says what the AI claims it says — AI tools sometimes invent plausible-looking sources."
    ],
    "tryIt": "Take the last AI answer you used for real work. Run it through the checklist above. Would it have changed anything?",
    "status": "published"
  },
  {
    "id": "lesson-workflow",
    "slug": "turning-it-into-a-workflow",
    "courseSlug": "get-useful-answers-from-ai",
    "order": 5,
    "title": "Turning this into a workflow you reuse",
    "format": "text",
    "readMinutes": 3,
    "body": [
      "A prompt you use once is a convenience. A prompt you save and reuse is a system — this is what the SSMI framework means by 'System': an ordered, repeatable way of doing a task, not a one-off trick.",
      "This course's workflow kit below has the reusable Task/Context/Format/Constraints template from Lesson 1, a copy of the verification checklist from Lesson 4, and a labelled sample so you can see the full pattern applied to an example.",
      "Save the template somewhere you'll actually find it again — a pinned note, a doc, or your AI tool's saved-prompts feature if it has one. The next time you have a similar question, start from the template instead of a blank box.",
      "That's the whole course: ask with enough context, ask for the shape you need, verify before you trust it, and keep the pattern so you don't have to rebuild it every time."
    ],
    "tryIt": "Complete the practice task in the workflow kit below, then mark this lesson's practice as complete.",
    "status": "published"
  }
] as const;
export const courseKit = {
  "id": "kit-ai-useful-answers",
  "courseSlug": "get-useful-answers-from-ai",
  "version": 1,
  "title": "Kaam ki Kit: Ask AI a Work Question",
  "promptPattern": "TASK: [What do you want the AI to do? One sentence.]\nCONTEXT: [What does the AI need to know that it can't guess?]\nFORMAT: [How should the answer look — list, table, email, word limit?]\nCONSTRAINTS: [What must it avoid or definitely include?]",
  "template": "TASK: Write a follow-up email about an overdue invoice.\nCONTEXT: Client hasn't replied in 5 days about a ₹40,000 invoice. This is the first follow-up — keep it low-pressure.\nFORMAT: Email under 100 words, with a subject line.\nCONSTRAINTS: Friendly but firm. No apology for following up. End with one clear question.",
  "templateDownloadPath": "/kits/get-useful-answers-from-ai-template.txt",
  "checklist": [
    "Numbers and dates: can you verify this specific figure from a source you trust? If not, treat it as a guess, not a fact.",
    "Names and claims about people or companies: would you be comfortable if this turned out to be wrong and someone asked \"where did you get that\"?",
    "Anything going out externally: read it once as if you were the recipient. Does it sound like something a careful person wrote?",
    "If the AI cites a source, check the source is real and says what the AI claims it says."
  ],
  "sampleOutput": "Sample output — synthetic example for illustration, not a real client or invoice. Notice it only uses facts given in the template above (amount, days overdue) and leaves placeholders for anything not provided, rather than inventing a name or invoice number.\n\nSubject: Quick check on your invoice\n\nHi [Client Name],\n\nHope you're doing well. Just following up on the ₹40,000 invoice sent five days ago — wanted to make sure it didn't slip through. Could you let me know an expected payment date, or flag if something's holding it up?\n\nThanks,\n[Your Name]",
  "practiceTask": "Pick one real question you need answered for work this week. Fill in the template with your own task (not the example), run it in any AI chat tool, and check the response against the verification checklist before you consider it done.",
  "successCriteria": [
    "You filled in all four TCFC fields with your own real task, not the example.",
    "You ran the completed prompt in an AI tool and got a response.",
    "You checked that response against the verification checklist before treating it as done."
  ]
} as const;
