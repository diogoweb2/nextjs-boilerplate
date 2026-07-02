/**
 * Fun money quotes for the monthly recap — one per month, chosen deterministically
 * (no AI, see BUSINESS_RULES.md) so a given month always shows the same quote and
 * previous reports stay stable. 100 curated quotes rotate through the year(s).
 */
export type Quote = { text: string; author?: string }

export const QUOTES: Quote[] = [
  { text: "A budget is just a plan for how to disappoint yourself with math every month." },
  { text: "Budgeting: Turning 'treat yourself' into 'treat yourself to rice and beans.'" },
  { text: "My budget is like my diet — great in theory, abandoned by Wednesday." },
  { text: "Living on a budget is just adulting with extra steps and fewer tacos." },
  { text: "A good budget tells your money to behave. A great budget has it on a leash." },
  { text: "Budgeting is the art of saying 'no' to yourself in the nicest spreadsheet possible." },
  { text: "I don't have a budget problem. I have a 'things I want' problem." },
  { text: "My budget and I have an agreement: it pretends to control me, I pretend to listen." },
  { text: "Budgeting is just procrastination with numbers." },
  { text: "If money talks, my budget is screaming 'WHY?!'" },
  { text: "A budget is a financial diet. Except pizza still finds a way in." },
  { text: "I'm on a strict budget. I can only afford to be disappointed once this month." },
  { text: "My budget is like my Wi-Fi — it works until I try to use it." },
  { text: "Budgeting: Because 'YOLO' got expensive real fast." },
  { text: "I follow a very strict budget… until I see something shiny." },
  { text: "A budget is proof that you and your money are in a toxic relationship." },
  { text: "My savings account and I are in a long-distance relationship." },
  { text: "Budget tip: If it's on sale and you don't need it, you're still saving money. Trust me." },
  { text: "I'm not broke, I'm pre-rich. My budget just hasn't caught up yet." },
  { text: "Budgeting is like trying to fold a fitted sheet — theoretically possible but nobody's ever done it." },
  { text: "My budget has two modes: 'Barely Surviving' and 'Let's See What Happens.'" },
  { text: "Nothing says 'adulting' like crying over a spreadsheet at 2 a.m." },
  { text: "I named my budget Karen. It keeps telling me I can't afford things." },
  { text: "A budget is just a list of things you're going to ignore." },
  { text: "My financial plan is simple: Make it rain… but only on bills." },
  { text: "Budgeting: The fine art of making $100 feel like $10." },
  { text: "I'm on a seafood diet. I see food and I spend money." },
  { text: "My budget is like a GPS — it keeps recalculating after I take the wrong exit." },
  { text: "Living within your means is easy. It's living within your wants that's the problem." },
  { text: "My wallet and my budget are currently not on speaking terms." },
  { text: "Budgeting is just deciding which dreams to postpone this month." },
  { text: "I have a love-hate relationship with my budget. Mostly hate." },
  { text: "A budget is a magical document that turns 'fun' into 'not this month.'" },
  { text: "My financial advisor is 90% vibes and 10% regret." },
  { text: "Budgeting: Because adulting without a spreadsheet is just financial Russian roulette." },
  { text: "I'm not cheap, I'm budget-conscious with commitment issues." },
  { text: "My budget is on a 'see food' diet — it sees money and it's gone." },
  { text: "A good budget is like a good relationship: full of boundaries and occasional disappointment." },
  { text: "I tried budgeting once. It was awful. 0/10 would not recommend." },
  { text: "Money can't buy happiness, but a good budget can delay the sadness." },
  { text: "My budget and reality are currently in couples therapy." },
  { text: "Budgeting is just organized suffering." },
  { text: "I don't always budget, but when I do, it's right before payday." },
  { text: "My spirit animal is a broke college student with expensive taste." },
  { text: "A budget is a list of excuses for why you can't do anything fun." },
  { text: "I'm on that new diet where I only eat what my budget allows. It's called sadness." },
  { text: "Budgeting: Turning impulse buys into calculated regrets." },
  { text: "My bank account and I are playing hard to get." },
  { text: "A budget is just future you saying 'please don't.'" },
  { text: "I have a flexible budget. It flexes right out of my control." },
  { text: "Budget tip: Stop buying things. (I'm still working on this one.)" },
  { text: "My budget is like my gym membership — I pay for it but never use it properly." },
  { text: "Living on a budget is easy. Staying on one is the plot twist." },
  { text: "I'm not broke, I'm on a budget so tight it squeaks." },
  { text: "My financial strategy is 50% hope, 50% coffee." },
  { text: "Budgeting is just adult hide-and-seek with your money." },
  { text: "I tried to follow my budget but my wants filed a formal complaint." },
  { text: "A budget is a written apology to your future self." },
  { text: "My budget is currently experiencing technical difficulties. Please stand by." },
  { text: "Budgeting: Because 'winging it' got expensive." },
  { text: "I'm on a budget. It's called 'whatever is left after bills.'" },
  { text: "Money doesn't grow on trees, but my spending habits do." },
  { text: "My budget has trust issues with me." },
  { text: "A good budget is like a horror movie — full of jump scares when you check the balance." },
  { text: "I'm saving money by pretending I have expensive taste but only window shopping." },
  { text: "Budgeting is the closest thing adults have to a superpower. Too bad I'm still level 1." },
  { text: "My wallet is on a strict no-spending diet. It's not going well." },
  { text: "I named my budget 'Expectations.' They're never met." },
  { text: "Budgeting: The noble art of saying no to your past self's terrible decisions." },
  { text: "My financial plan is 'make more money' but my budget says 'lol no.'" },
  { text: "A budget is just a love letter to financial anxiety." },
  { text: "I'm not irresponsible with money. My money is just very adventurous." },
  { text: "Budgeting is like trying to hold water in your hands — impressive until it isn't." },
  { text: "My budget and I are in an open relationship with takeout." },
  { text: "I have a strict budget. Unfortunately it's very understanding." },
  { text: "Living on a budget is 10% planning, 90% creative math." },
  { text: "My savings goal is 'not panic when the car breaks down.'" },
  { text: "A budget is a therapist that charges you nothing and still makes you cry." },
  { text: "I'm on a budget so tight I can hear it squeak when I walk." },
  { text: "Budgeting: Because spontaneous joy is overrated." },
  { text: "My money and I have different priorities. Mostly mine." },
  { text: "A budget is just a to-do list for your bank account." },
  { text: "I tried adulting without a budget. It was like skydiving without a parachute — thrilling but brief." },
  { text: "My budget is basically a participation trophy for trying." },
  { text: "Budgeting is just deciding which version of broke you prefer this month." },
  { text: "I'm financially responsible… in spirit." },
  { text: "My budget has more red flags than a bullfight." },
  { text: "A good budget is like a good ex — it reminds you why you left." },
  { text: "I don't need a budget. I need a money printer." },
  { text: "Budgeting is the adult version of 'don't spend your allowance all at once.'" },
  { text: "My financial literacy is mostly vibes and Google searches." },
  { text: "A budget is proof that hope is not a financial strategy." },
  { text: "I'm saving for a rainy day. Unfortunately it's been pouring since 2022." },
  { text: "My budget is like my hairline — receding fast." },
  { text: "Budgeting: Turning 'I deserve this' into 'I deserve better financial decisions.'" },
  { text: "I have a very sophisticated budget. It's called denial." },
  { text: "My money management style is 'chaotic neutral.'" },
  { text: "A budget is just a list of things you'll buy anyway and feel bad about later." },
  { text: "I'm not bad with money. Money is bad with me." },
  { text: "The best budget is the one you make… and the second best is the one you ignore while eating sushi." },
]

/**
 * Deterministic quote for a YYYY-MM month. `(year*12 + month)` walks the list one
 * step per calendar month and wraps, so the cadence is stable and repeatable.
 */
export function quoteForMonth(ym: string): Quote {
  const [y, m] = ym.split('-').map(Number)
  if (!y || !m || QUOTES.length === 0) return QUOTES[0] ?? { text: '' }
  const idx = (y * 12 + (m - 1)) % QUOTES.length
  return QUOTES[idx]
}

/**
 * Deterministic quote for a whole year (the Year in Review). Offset by a prime
 * stride so it never lands on any of that year's twelve monthly quotes.
 */
export function quoteForYear(year: number): Quote {
  if (QUOTES.length === 0) return { text: '' }
  const idx = (year * 37 + 11) % QUOTES.length
  return QUOTES[idx]
}
