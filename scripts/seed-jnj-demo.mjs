import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";

const prisma = new PrismaClient();

const WORKSPACE_SLUG = "jnj-demo";
const WORKSPACE_NAME = "Johnson & Johnson";
const WORKSPACE_DESC = "Demo workspace populated with public J&J data (Illustrative purposes only)";

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
}

const nDaysAgo = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
};

const nDaysFromNow = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
};

const nDaysAgoAtNoonUtc = (days) => {
  const d = nDaysAgo(days); d.setUTCHours(12, 0, 0, 0); return d;
};

const MEETING_PROCESSING_STAGES = [
  "UPLOADED",
  "SUMMARIZING",
  "EXTRACTING_INSIGHTS",
  "SYNCING_OUTPUTS",
  "INDEXING_BRAIN",
  "READY",
];

function completedMeetingProcessingStageStatuses(completedAt) {
  const iso = completedAt.toISOString();
  return Object.fromEntries(MEETING_PROCESSING_STAGES.map((stage) => [stage, {
    status: "COMPLETED",
    startedAt: iso,
    completedAt: iso,
    failedAt: null,
    skippedAt: null,
    updatedAt: iso,
    workflowJobId: null,
    workflowJobType: null,
    workflowJobStatus: "COMPLETED",
    attempts: 1,
    chunkIndex: null,
    chunkCount: null,
    safeErrorCode: null,
    safeErrorMessage: null,
  }]));
}

// Data Definition
const DEMO_LINKEDIN_URL = "https://www.linkedin.com/company/johnson-&-johnson/";
const DEMO_WEBSITE_URL = "https://www.jnj.com/";

const TEAM_MEMBERS = [
  { email: "demo@jnj-demo.corgtex.app", name: "Demo User", role: "ADMIN", password: "demo1234", title: "Observer", bio: "Demo workspace observer used to review member, role, circle, proposal, tension, and meeting navigation." },
  { email: "jduato@jnj.demo.corgtex.app", name: "Joaquin Duato", role: "ADMIN", title: "Chairman & CEO", bio: "Enterprise leader focused on portfolio strategy, operating cadence, and cross-segment governance." },
  { email: "jwolk@jnj.demo.corgtex.app", name: "Joseph J. Wolk", role: "FINANCE_STEWARD", title: "EVP, CFO", bio: "Finance steward for capital allocation, audit readiness, and performance reporting." },
  { email: "jtaubert@jnj.demo.corgtex.app", name: "Jennifer L. Taubert", role: "FACILITATOR", title: "Worldwide Chairman, Innovative Medicine", bio: "Facilitates Innovative Medicine priorities across oncology, immunology, and commercial strategy." },
  { email: "tschmid@jnj.demo.corgtex.app", name: "Timothy Schmid", role: "FACILITATOR", title: "Worldwide Chairman, MedTech", bio: "Leads MedTech operating priorities, including Abiomed integration and international commercialization." },
  { email: "jreed@jnj.demo.corgtex.app", name: "John C. Reed", role: "CONTRIBUTOR", title: "EVP, R&D", bio: "R&D contributor connecting pipeline strategy, clinical development, and portfolio prioritization." },
  { email: "vbroadhurst@jnj.demo.corgtex.app", name: "Vanessa Broadhurst", role: "CONTRIBUTOR", title: "EVP, Global Corporate Affairs", bio: "Corporate affairs contributor focused on public trust, ESG reporting, and health equity work." },
  { email: "mullmann@jnj.demo.corgtex.app", name: "Michael Ullmann", role: "CONTRIBUTOR", title: "EVP, General Counsel", bio: "Legal and compliance contributor for governance, risk, and enterprise policy decisions." },
  { email: "pfasolo@jnj.demo.corgtex.app", name: "Peter Fasolo", role: "CONTRIBUTOR", title: "EVP, CHRO", bio: "People and culture contributor focused on talent, leadership systems, and workforce planning." },
];

const CIRCLES = [
  { id: "board", name: "Executive Committee", purpose: "Company-wide governance and strategic oversight" },
  { id: "innovative-medicine", name: "Innovative Medicine", purpose: "Pharmaceutical R&D, commercialization, and manufacturing" },
  { id: "medtech", name: "MedTech", purpose: "Medical devices, surgical solutions, and vision" },
  { id: "rd", name: "Research & Development", purpose: "Cross-cutting R&D strategy and pipeline management" },
  { id: "finance", name: "Finance & Audit", purpose: "Financial governance, budgeting, and capital allocation" },
  { id: "esg", name: "ESG & Sustainability", purpose: "Health for Humanity initiatives and compliance" }
];

const ROLES = [
  { circle: "board", name: "Chairman & CEO", assignee: "jduato", purpose: "Enterprise leadership", accountabilities: ["Lead executive committee", "Set corporate strategy"] },
  { circle: "board", name: "Chief Financial Officer", assignee: "jwolk", purpose: "Financial leadership", accountabilities: ["Manage capital allocation", "Oversee financial reporting"] },
  { circle: "board", name: "General Counsel", assignee: "mullmann", purpose: "Legal and compliance", accountabilities: ["Manage corporate legal strategies", "Ensure compliance"] },
  { circle: "board", name: "Chief Human Resources Officer", assignee: "pfasolo", purpose: "Talent and culture", accountabilities: ["Lead global HR strategy", "Manage executive compensation"] },
  { circle: "board", name: "EVP Global Corporate Affairs", assignee: "vbroadhurst", purpose: "Corporate communications", accountabilities: ["Lead public relations", "Manage ESG reporting"] },
  { circle: "innovative-medicine", name: "Worldwide Chairman", assignee: "jtaubert", purpose: "Pharma segment leadership", accountabilities: ["Drive commercial strategy", "Manage P&L"] },
  { circle: "innovative-medicine", name: "VP Oncology", assignee: "jreed", purpose: "Oncology portfolio", accountabilities: ["Lead oncology franchise", "Drive DARZALEX growth"] },
  { circle: "innovative-medicine", name: "VP Immunology", assignee: "jtaubert", purpose: "Immunology portfolio", accountabilities: ["Manage STELARA transition", "Drive TREMFYA growth"] },
  { circle: "innovative-medicine", name: "VP Neuroscience", assignee: null, purpose: "Neuro portfolio", accountabilities: [] },
  { circle: "innovative-medicine", name: "VP Cardiovascular & Metabolism", assignee: null, purpose: "CVM portfolio", accountabilities: [] },
  { circle: "medtech", name: "Worldwide Chairman", assignee: "tschmid", purpose: "MedTech segment leadership", accountabilities: ["Drive MedTech P&L", "Integrate acquired businesses"] },
  { circle: "medtech", name: "VP Electrophysiology & Cardiovascular", assignee: "tschmid", purpose: "Cardio devices", accountabilities: ["Oversee Abiomed integration", "Expand electrophysiology"] },
  { circle: "medtech", name: "VP Orthopedics", assignee: null, purpose: "Ortho devices", accountabilities: [] },
  { circle: "medtech", name: "VP Surgery", assignee: null, purpose: "Surgical tech", accountabilities: [] },
  { circle: "medtech", name: "VP Vision", assignee: null, purpose: "Vision care", accountabilities: [] },
  { circle: "rd", name: "EVP Research & Development", assignee: "jreed", purpose: "Enterprise R&D", accountabilities: ["Manage pipeline", "Allocate R&D capital"] },
  { circle: "rd", name: "Head of Pipeline Strategy", assignee: "jreed", purpose: "Portfolio prioritization", accountabilities: [] },
  { circle: "rd", name: "Head of Clinical Development", assignee: null, purpose: "Trial management", accountabilities: [] },
  { circle: "finance", name: "Head of Internal Audit", assignee: "jwolk", purpose: "Financial controls", accountabilities: ["Ensure SOX compliance"] },
  { circle: "finance", name: "Head of Treasury", assignee: "jwolk", purpose: "Cash management", accountabilities: ["Manage liquidity", "Issue debt"] },
  { circle: "finance", name: "Head of Investor Relations", assignee: null, purpose: "Shareholder comms", accountabilities: [] },
  { circle: "esg", name: "Head of Health Equity", assignee: "vbroadhurst", purpose: "Health access", accountabilities: ["Drive global health initiatives"] },
  { circle: "esg", name: "Head of Climate Strategy", assignee: "vbroadhurst", purpose: "Environmental goals", accountabilities: ["Track Scope 1-3 emissions"] }
];

const ARTICLES = [
  { title: "2024 Financial Overview & Strategy", type: "STRATEGY", authority: "AUTHORITATIVE",
    body: `# 2024 Financial Performance & Strategy\n\n## Overview\nIn 2024, Johnson & Johnson delivered strong financial performance, demonstrating the resilience and scale of our decentralized operating model. We focus specifically on Innovative Medicine and MedTech to drive the next wave of healthcare innovation.\n\n## Key Metrics\n- **Total Revenue**: $88.8 billion (reported growth of 4.3%)\n- **Innovative Medicine Revenue**: ~$57 billion (64% of total)\n- **MedTech Revenue**: ~$31.9 billion (36% of total)\n- **Employees**: ~138,100 globally\n\n## Strategic Growth Drivers\nWe are advancing our pipeline and pursuing strategic M&A across both segments. Key growth products include DARZALEX, ERLEADA, CARVYKTI, and TREMFYA in Innovative Medicine, and electrophysiology and Abiomed in MedTech.\n\n## Decentralized Management Structure\nThe Company's decentralized management model aims to foster agility and responsiveness to local market conditions while maintaining robust centralized corporate governance.` },
  
  { title: "Innovative Medicine Segment", type: "ARCHITECTURE", authority: "AUTHORITATIVE",
    body: `# Innovative Medicine\n\n## Focus Areas\nOur Innovative Medicine segment (formerly Pharmaceutical) is focused on several key therapeutic areas to address severe unmet medical needs:\n\n1. **Oncology** (e.g., DARZALEX, CARVYKTI, ERLEADA)\n2. **Immunology** (e.g., TREMFYA, STELARA)\n3. **Neuroscience**\n4. **Cardiovascular & Metabolism**\n5. **Pulmonary Hypertension**\n\n## Strategy\nThe strategy relies intensely on R&D investment (significantly exceeding $10B annually) and strategic partnerships or acquisitions to bring novel therapies to patients. In 2024, the segment generated nearly $57 billion in revenue.` },

  { title: "MedTech Segment", type: "ARCHITECTURE", authority: "AUTHORITATIVE",
    body: `# MedTech\n\n## Overview\nOur MedTech segment creates solutions in orthopedic, surgery, interventional solutions, and vision. We aim to elevate the standard of care through connected, digital, and robotic technologies.\n\n## Core Portfolios\n- **Electrophysiology & Cardiovascular** (Includes Abiomed growth)\n- **Orthopedics**\n- **Surgery** (Advanced and General)\n- **Vision** (Surgical and Vision Care)\n\n## Recent Innovations\nThe ongoing integration of Abiomed and the expansion of our robotic surgery platforms form a major part of the capital allocation focus for MedTech.` },

  { title: "Health for Humanity Sustainability Goals", type: "PROCESS", authority: "REFERENCE",
    body: `# ESG & Sustainability: Health for Humanity\n\n## Philosophy\nRooted in Our Credo, Johnson & Johnson considers ESG principles fundamental to our business. The Regulatory Compliance & Sustainability Committee (RCSC) oversees these initiatives.\n\n## Key Commitments\n- **Climate Action**: Progress toward science-based emissions targets across our operations.\n- **Health Equity**: Investing in access to care for underserved populations globally.\n- **Diversity, Equity, and Inclusion**: Enhancing representation at all leadership levels.\n- **Product Quality**: Maintaining exceptional standards across supply chains.\n\n## 2024 Progress\nRefer to the upcoming Health for Humanity report for detailed metrics regarding carbon footprint reduction and diversity milestones.` },

  { title: "Our Credo", type: "CULTURE", authority: "AUTHORITATIVE",
    body: `# Our Credo\n\nOur Credo challenges us to put the needs and well-being of the people we serve first.\n\n1. **Patients, Doctors, Nurses**: We believe our first responsibility is to the patients, doctors and nurses, to mothers and fathers and all others who use our products and services.\n2. **Employees**: We are responsible to our employees who work with us throughout the world. We must respect their dignity and recognize their merit.\n3. **Communities**: We are responsible to the communities in which we live and work and to the world community as well.\n4. **Stockholders**: Our final responsibility is to our stockholders. Business must make a sound profit. When we operate according to these principles, the stockholders should realize a fair return.` },

  { title: "DARZALEX Commercial Strategy", type: "PRODUCT", authority: "REFERENCE",
    body: `# DARZALEX\n\n## Product Profile\nDARZALEX is a CD38-directed cytolytic antibody indicated for the treatment of multiple myeloma.\n\n## Market Position\nIt remains a cornerstone of our Oncology portfolio, experiencing robust double-digit growth globally. The subcutaneous formulation (DARZALEX FASPRO) has driven significant market share gains due to improved patient convenience.\n\n## Future Considerations\nWe are actively monitoring the competitive landscape and initiating life-cycle management trials to expand indications in earlier lines of therapy.` },

  { title: "Abiomed Integration & Cardiovascular Growth", type: "PRODUCT", authority: "REFERENCE",
    body: `# Abiomed Integration\n\n## Context\nThe acquisition of Abiomed bolsters our MedTech cardiovascular portfolio with the Impella heart pump platform.\n\n## Performance\nSince integration, Abiomed has contributed significantly to MedTech operational growth. The focus is on scaling international commercialization and expanding clinical evidence supporting prophylactic use in high-risk PCIs.\n\n## Operational Synergy\nWe are integrating supply chain elements while allowing Abiomed's R&D teams to operate with the agility that made them successful.` },

  { title: "Capital Allocation Framework", type: "STRATEGY", authority: "AUTHORITATIVE",
    body: `# Capital Allocation Framework\n\n## Priorities\n1. **Organic Investments**: R&D and capital expenditures remain the top priority to drive internal innovation.\n2. **Dividends**: Maintaining our status as a Dividend King; consistently increasing dividends annually.\n3. **Strategic M&A**: Pursuing value-creating acquisitions, particularly in high-growth segments of MedTech and targeted therapeutic areas in Innovative Medicine.\n4. **Share Repurchases**: Supplementing shareholder returns when valuation is compelling.` },
  
  { title: "Pipeline & Clinical Trials Overview", type: "PRODUCT", authority: "AUTHORITATIVE",
    body: `# Pipeline & Clinical Trials\n\nOur pipeline is robust and deep, driving the next decade of innovation. We maintain aggressive pursuit of early-stage assets while efficiently accelerating late-stage trials. Key domains include Oncology, Immunology, and Neurology.` },
  
  { title: "Kenvue Separation Impact Analysis", type: "STRATEGY", authority: "REFERENCE",
    body: `# Kenvue Separation Impact\n\nThe separation of Kenvue allows J&J to operate uniquely as a two-sector powerhouse in Innovative Medicine and MedTech. This strategic shift unlocks capital for higher-margin growth areas.` },
  
  { title: "Digital Surgery & Robotics Strategy", type: "ARCHITECTURE", authority: "REFERENCE",
    body: `# Digital Surgery Strategy\n\nWe are deploying the Monarch and Velys platforms globally, pushing the boundaries of integrated digital capabilities in standard operating rooms. Our primary barrier is securing capital approvals for health systems in EMEA.` },
  
  { title: "Global Supply Chain Risk Management", type: "PROCESS", authority: "AUTHORITATIVE",
    body: `# Global Supply Chain Risk\n\nFollowing post-pandemic disruptions, J&J has decentralized critical manufacturing nodes. Dual-sourcing mandates are heavily enforced across tier-1 suppliers, specifically in active pharmaceutical ingredients.` },
  
  { title: "Board Committee Charter Summary", type: "CULTURE", authority: "AUTHORITATIVE",
    body: `# Board Committee Charters\n\nThe five key committees enforce rigorous standards. The Audit and RCSC committees both meet independently without management to ensure transparency.` },
  
  { title: "Employee Value Proposition & Talent Strategy", type: "TEAM", authority: "REFERENCE",
    body: `# Talent Strategy\n\nRecruiting and retaining top talent in AI and digital surgery is our top HR priority. We leverage a flexible work strategy and robust internal mobility program to maintain engagement.` }
];

const MEETINGS = [
  { title: "Q4 2024 Earnings Final Review", recordedAt: "2025-01-15T10:00:00Z",
    participants: ["jduato", "jwolk", "jtaubert", "tschmid"],
    transcript: "J. Duato: Let's review the Q4 numbers. We closed the year strong at $88.8 billion in revenue. Innovative Medicine delivered almost $57 billion, and MedTech contributed $31.9 billion. J. Wolk: Yes, operational growth was solid. DARZALEX and TREMFYA were the main drivers in IM. In MedTech, electrophysiology is outperforming. We do see some margin pressure from supply chain, but overall EPS is in line. J. Taubert: Looking at STELARA, we need to prepare for biosimilar impacts next year. I propose we increase the localized commercial push for TREMFYA. T. Schmid: For MedTech, Abiomed integration is going smoothly, but we need to accelerate international rollout to justify the ROI. Let's allocate more budget to the EU team.",
    summary: "Reviewed Q4 2024 performance showing $88.8B total revenue. Innovative Medicine ($57B) driven by DARZALEX and TREMFYA. MedTech ($31.9B) led by electrophysiology and Abiomed. Discussed margin pressures, upcoming STELARA biosimilar competition, and accelerating Abiomed's international rollout."
  },
  { title: "Executive Committee Strategic Planning", recordedAt: "2024-11-20T14:00:00Z",
    participants: ["jduato", "jreed", "jwolk", "pfasolo"],
    transcript: "J. Duato: Welcome everyone. Today we align on our 2025 capital allocation. Following the Kenvue separation, our focus must be strictly on high-growth pharma and MedTech. J. Reed: The pipeline is robust, but I need an additional $500M in the oncology R&D budget to accelerate the CARVYKTI scale-up and new indications. J. Wolk: The capital framework supports R&D first, but we are also targeting specific MedTech tuck-in acquisitions. P. Fasolo: Culturally, our Credo survey shows employees want more clarity on the future of our decentralized model. We must communicate that agility remains our priority.",
    summary: "Aligned on 2025 strategy post-Kenvue. Confirmed focus on high-growth Innovative Medicine and MedTech. Requested $500M R&D boost for CARVYKTI oncology scale-up. Reaffirmed commitment to the decentralized operating model and Our Credo."
  },
  { title: "ESG & Regulatory Compliance Update", recordedAt: "2024-10-10T09:00:00Z",
    participants: ["mullmann", "vbroadhurst", "jwolk"],
    transcript: "M. Ullmann: As part of the RCSC oversight, we need to finalize our Health for Humanity reporting for the year. V. Broadhurst: We are on track for our science-based climate targets, specifically renewable electricity. However, we have a tension regarding supplier emissions (Scope 3). It's difficult to track. I propose we mandate ESG reporting from our top 50 global suppliers next year. J. Wolk: Agreed, but we must provide them with the monitoring tools or we risk supply chain disruption. Let's form an action group.",
    summary: "Reviewed Health for Humanity progress. On track for internal climate targets but facing challenges with Scope 3 supplier emissions tracking. Proposed to mandate ESG reporting for top 50 suppliers, with a plan to assist them via monitoring tools to prevent supply chain disruption."
  },
  { title: "Board of Directors Quarterly Review", recordedAt: "2024-12-18T10:00:00Z",
    participants: ["pfasolo", "jwolk", "jduato"],
    transcript: "P. Fasolo: Presenting the talent retention numbers in key R&D hubs... retention remains strong. J. Wolk: Debt issuance strategy for early 2025 is structured to maintain our AAA rating.",
    summary: "Reviewed board governance, committee reports, and FY2025 financial outlook."
  },
  { title: "MedTech Product Strategy Deep Dive", recordedAt: "2024-09-15T09:00:00Z",
    participants: ["tschmid", "jduato", "jwolk"],
    transcript: "T. Schmid: The Monarch platform is showing robust adoption curves, but Velys needs more localized training centers in EMEA.",
    summary: "Deep dive into robotic surgery roadmap, Abiomed international expansion, and Vision Care."
  },
  { title: "Innovation & AI Working Group Kickoff", recordedAt: "2025-01-28T14:00:00Z",
    participants: ["jreed", "tschmid", "jduato"],
    transcript: "J. Reed: Generative AI will change target optimization. We are establishing an internal COE to standardize tooling.",
    summary: "Discussed AI governance, drug discovery ML platforms, and digital twin pilots."
  }
];

const MEETING_INSIGHTS = [
  {
    meetingTitle: "Innovation & AI Working Group Kickoff",
    idSuffix: "applied-ai-coe-decision",
    type: "DECISION",
    status: "APPLIED",
    confidence: 0.93,
    title: "#001 > R&D AI Center of Excellence - standardize tooling",
    bodyMd: "**CONTEXT:** R&D teams are experimenting with generative AI in separate tools.\n\n**REQUEST:** Establish a shared operating model for target optimization and AI governance.\n\n**ANSWER:** The working group agreed to establish an internal Center of Excellence.\n\n**RESULT:** PROCESSED",
    assigneeHint: "John C. Reed",
    sourceQuote: "Generative AI will change target optimization. We are establishing an internal COE to standardize tooling.",
    appliedEntityType: "Decision",
    autoAppliedAt: nDaysAgo(0),
  },
  {
    meetingTitle: "Innovation & AI Working Group Kickoff",
    idSuffix: "needs-review-ai-governance",
    type: "ACTION_ITEM",
    status: "SUGGESTED",
    confidence: 0.72,
    title: "#002 > John C. Reed AI Governance - draft working-group charter",
    bodyMd: "**CONTEXT:** The AI Center of Excellence needs a clear charter before teams adopt shared tools.\n\n**REQUEST:** Turn the kickoff discussion into an accountable next step.\n\n**ANSWER:** Draft the working-group charter and circulate it before the next R&D review.\n\n**RESULT:** OPEN",
    assigneeHint: "John C. Reed",
    sourceQuote: "We are establishing an internal COE to standardize tooling.",
  },
  {
    meetingTitle: "Innovation & AI Working Group Kickoff",
    idSuffix: "low-confidence-digital-twin",
    type: "PROPOSAL",
    status: "SUGGESTED",
    confidence: 0.38,
    title: "#003 > Digital Twin Pilot - evaluate MedTech transferability",
    bodyMd: "**CONTEXT:** Digital twin pilots were mentioned as a possible learning area for AI-enabled operations.\n\n**REQUEST:** Consider whether the drug-discovery AI governance model should also cover MedTech digital twin pilots.\n\n**ANSWER:** The transcript hints at this connection, but does not clearly assign an owner or decision.\n\n**RESULT:** PENDING",
    assigneeHint: "Timothy Schmid",
    sourceQuote: "Discussed AI governance, drug discovery ML platforms, and digital twin pilots.",
  },
];

const TENSIONS = [
  { title: "STELARA biosimilar erosion risk", status: "OPEN", assignee: null,
    body: "With STELARA facing biosimilar competition soon, we need a definitive strategy to transition patients and secure revenue lines via TREMFYA and other immunology assets." },
  { title: "Scope 3 Supplier Emissions Tracking", status: "OPEN", assignee: null,
    body: "We cannot accurately report our full Health for Humanity climate impact without better data from our top 50 tier-1 suppliers." },
  { title: "Oncology R&D Budget Constraints", status: "OPEN", assignee: null,
    body: "CARVYKTI scale-up requires more capital to expand manufacturing capacity and clinical trials for earlier lines of therapy." },
  { title: "Abiomed International Rollout Velocity", status: "OPEN", assignee: null,
    body: "European expansion for Abiomed is lagging behind financial models. Need dedicated commercial teams in the DACH region." },
  { title: "AI Integration in Drug Discovery", status: "OPEN", assignee: null,
    body: "Competitors are accelerating lead optimization using generative AI. We lack a unified AI infrastructure across the R&D segment." },
  { title: "Post-Kenvue Brand Identity Transition", status: "OPEN", assignee: "vbroadhurst",
    body: "Need to fully distinguish J&J as an enterprise exclusively focused on healthcare innovation." },
  { title: "MedTech Regulatory Approval Delays in EU", status: "RESOLVED", assignee: "tschmid", publishedAt: nDaysAgoAtNoonUtc(18), resolvedAt: nDaysAgoAtNoonUtc(5), resolvedVia: "Regulatory review owners were assigned by market and the EU launch calendar was resequenced around the highest-confidence approvals.",
    body: "MDR compliance is creating a bottleneck for our Vision products in specific EU markets." },
  { title: "Clinical Staff Retention in Key R&D Sites", status: "OPEN", assignee: "pfasolo",
    body: "We are seeing 15% attrition in our clinical site management talent, primarily to biotech startups." }
];

const ACTIONS = [
  {
    title: "Review Top 50 Supplier ESG Reports",
    status: "OPEN",
    assignee: "vbroadhurst",
    dueInDays: 0,
    checklist: [
      { title: "Confirm latest supplier files are attached", completed: true },
      { title: "Summarize missing Scope 3 disclosures", completed: false },
      { title: "Send RCSC readout", completed: false },
    ],
  },
  {
    title: "Draft TREMFYA Commercial Continuity Plan",
    status: "IN_PROGRESS",
    assignee: "jtaubert",
    dueInDays: 1,
    checklist: [
      { title: "Map biosimilar exposure by region", completed: true },
      { title: "Review continuity plan with finance", completed: false },
    ],
  },
  { title: "Finalize EU budget allocation for Abiomed", status: "IN_PROGRESS", assignee: "tschmid", dueInDays: 3 },
  { title: "Approve $500M oncology R&D supplement", status: "COMPLETED", assignee: "jwolk", dueInDays: -4 },
  { title: "Schedule Board Strategic Offsite for Q2", status: "OPEN", assignee: "pfasolo", dueInDays: 9 },
  { title: "File TREMFYA EU Label Extension", status: "IN_PROGRESS", assignee: "jtaubert", dueInDays: 22 },
  { title: "Submit FY2025 ESG Targets to RCSC", status: "OPEN", assignee: "vbroadhurst", dueInDays: 5 },
  { title: "Complete Abiomed DACH Hiring Plan", status: "COMPLETED", assignee: "tschmid", dueInDays: -2 }
];

const PROPOSALS = [
  { 
    title: "Expand DARZALEX Subcutaneous Roll-out to APAC Markets", status: "RESOLVED", resolutionOutcome: "ADOPTED", author: "jtaubert", circle: "innovative-medicine", publishedAt: nDaysAgo(60),
    summary: "Approval to increase marketing spend for the subcutaneous formulation rollout in key APAC regions.",
    body: "We are seeking $12.5M to aggressively launch the DARZALEX FASPRO formula in Japan and South Korea, targeting a 15% share capture in Q1."
  },
  { 
    title: "Establish AI Center of Excellence for Drug Discovery", status: "OPEN", author: "jreed", circle: "rd", publishedAt: nDaysAgo(4),
    summary: "Formation of an internal COE to standardize generative AI tooling.",
    body: "Currently, AI usage is fragmented across R&D. This proposal establishes a $20M fund to build a centralized infrastructure leveraging Azure ML."
  },
  { 
    title: "Mandate Tier-1 Supplier ESG Reporting", status: "OPEN", author: "vbroadhurst", circle: "esg", publishedAt: nDaysAgo(2),
    summary: "Require our top 50 suppliers to report Scope 1-3 emissions bi-annually via the EcoVadis platform.",
    body: "To hit our Health for Humanity target, we must mandate that all Tier-1 suppliers onboard onto our reporting framework before Q4. We will cover the first-year licensing costs."
  },
  { 
    title: "Q1 2025 Capital Allocation Amendment", status: "RESOLVED", resolutionOutcome: "ADOPTED", author: "jwolk", circle: "finance", publishedAt: nDaysAgo(45),
    summary: "Rebalance capital toward R&D and aggressive debt retirement.",
    body: "This amendment shifts $800M from general corporate purposes directly into the R&D Innovation Grant account."
  },
  { 
    title: "Robotic Surgery Platform: Phase II Scale-Up", status: "OPEN", author: "tschmid", circle: "medtech", publishedAt: nDaysAgo(10),
    summary: "Funding for advanced clinical validation of the Monarch system.",
    body: "Proposing $45M over two years to accelerate multi-center validation for bronchoscopy procedures."
  },
  { 
    title: "Decentralized Talent Mobility Program", status: "DRAFT", author: "pfasolo", circle: "board", publishedAt: nDaysAgo(1),
    summary: "A new HR framework allowing 10% talent rotation between MedTech and IM.",
    body: "We need cross-pollination. This framework will subsidize short-term assignments across segments."
  },
  { 
    title: "CARVYKTI Manufacturing Capacity Expansion", status: "RESOLVED", resolutionOutcome: "ADOPTED", author: "jreed", circle: "innovative-medicine", publishedAt: nDaysAgo(25),
    summary: "Significant investment in cell-therapy manufacturing nodes.",
    body: "Demand outpaces supply. We are requesting an immediate $350M CapEx release to construct two new clean-room facilities."
  },
  { 
    title: "Revise Executive Compensation Structure", status: "RESOLVED", resolutionOutcome: "WITHDRAWN", author: "pfasolo", circle: "board", publishedAt: nDaysAgo(80), archivedAt: nDaysAgo(70),
    summary: "Shift LTI weighting toward ESG metrics.",
    body: "Proposal to link 15% of the long-term incentive plan to our Health for Humanity diversity goals."
  },
  { 
    title: "Global Clinical Trial Data Sharing Framework", status: "OPEN", author: "jreed", circle: "rd", publishedAt: nDaysAgo(8),
    summary: "Standardize how we share anonymized trial data with academic partners.",
    body: "We need a governed process for accelerating academic research through secured data enclaves."
  },
  { 
    title: "MedTech Digital Twin Manufacturing Pilot", status: "OPEN", author: "tschmid", circle: "medtech", publishedAt: nDaysAgo(15),
    summary: "Deploying digital twins in our orthopedics manufacturing line.",
    body: "Propose a pilot with Siemens to reduce waste by 12% via real-time twin simulation."
  },
  { 
    title: "Supplier Diversity Spending Target for FY2026", status: "RESOLVED", resolutionOutcome: "ADOPTED", author: "vbroadhurst", circle: "esg", publishedAt: nDaysAgo(50),
    summary: "Commit to $5B in spend with diverse suppliers.",
    body: "Continuing our commitment to economic inclusion across our global procurement network."
  },
  { 
    title: "Cross-Segment AI Governance Policy", status: "DRAFT", author: "mullmann", circle: "board", publishedAt: nDaysAgo(2),
    summary: "Legal framework for releasing external-facing LLMs.",
    body: "All generative products must clear this rigorous 6-step review process focused on IP safety and hallucination checks."
  }
];

const SCORES = [
  { periodEnd: nDaysAgo(270), score: 62, parts: { participationPct: 58, decisionVelocityHrs: 48, policyCoverage: 45, tensionResolutionPct: 52, constitutionFreshness: 70 } },
  { periodEnd: nDaysAgo(180), score: 71, parts: { participationPct: 68, decisionVelocityHrs: 36, policyCoverage: 60, tensionResolutionPct: 65, constitutionFreshness: 75 } },
  { periodEnd: nDaysAgo(90), score: 78, parts: { participationPct: 82, decisionVelocityHrs: 24, policyCoverage: 72, tensionResolutionPct: 78, constitutionFreshness: 85 } },
];

const PRACTICE_PROJECTS = [
  {
    code: "MEDTECH-EMEA",
    name: "Digital Surgery EMEA rollout",
    clientName: "MedTech Commercial",
    status: "ACTIVE",
    poValueCents: 420000000,
    serviceBudgetCents: 280000000,
    expenseBudgetCents: 65000000,
    usedCents: 214000000,
    weeklyBurnCents: 27000000,
    targetMarginBps: 5800,
    currentMarginBps: 6100,
    sourceSatelliteId: "jnj-demo-practice-medtech-emea",
  },
  {
    code: "ONC-MFG-01",
    name: "CARVYKTI manufacturing scale-up",
    clientName: "Innovative Medicine",
    status: "ON_HOLD",
    poValueCents: 520000000,
    serviceBudgetCents: 390000000,
    expenseBudgetCents: 85000000,
    usedCents: 138000000,
    weeklyBurnCents: 18000000,
    targetMarginBps: 5200,
    currentMarginBps: 4900,
    sourceSatelliteId: "jnj-demo-practice-onc-mfg-01",
  },
  {
    code: "ESG-SUPPLIER",
    name: "Supplier ESG monitoring program",
    clientName: "ESG & Sustainability",
    status: "ACTIVE",
    poValueCents: 175000000,
    serviceBudgetCents: 112000000,
    expenseBudgetCents: 24000000,
    usedCents: 132000000,
    weeklyBurnCents: 11500000,
    targetMarginBps: 5400,
    currentMarginBps: 5050,
    sourceSatelliteId: "jnj-demo-practice-esg-supplier",
  },
];

const PRACTICE_CONTRIBUTIONS = [
  {
    projectCode: "MEDTECH-EMEA",
    memberKey: "tschmid",
    type: "TIME",
    paymentChoice: "SLICING_PIE",
    description: "Program steering and EMEA rollout working sessions",
    occurredAt: nDaysAgoAtNoonUtc(18),
    hoursTenths: 125,
    rateCents: 18500,
  },
  {
    projectCode: "ESG-SUPPLIER",
    memberKey: "vbroadhurst",
    type: "EXPENSE",
    paymentChoice: "SLICING_PIE",
    description: "Supplier evidence review and verification travel",
    occurredAt: nDaysAgoAtNoonUtc(12),
    amountCents: 680000,
    currency: "USD",
  },
  {
    projectCode: "MEDTECH-EMEA",
    memberKey: "jwolk",
    type: "EXPENSE",
    paymentChoice: "CASH",
    description: "Finance review workshop expenses",
    occurredAt: nDaysAgoAtNoonUtc(7),
    amountCents: 240000,
    currency: "USD",
    paid: true,
  },
];

const SHOWCASE_GOALS = [
  {
    title: "Ship Agent Governance v2",
    descriptionMd: "Complete the agent registry, observability traces, spend controls, and access management features.",
    level: "COMPANY",
    cadence: "QUARTERLY",
    status: "ON_TRACK",
    progressPercent: 72,
    targetDate: new Date("2026-06-30"),
  },
  {
    title: "Onboard 5 Enterprise Pilots",
    descriptionMd: "Convert pipeline prospects into active pilot deployments with full governance setup.",
    level: "COMPANY",
    cadence: "QUARTERLY",
    status: "ON_TRACK",
    progressPercent: 40,
    targetDate: new Date("2026-06-30"),
  },
  {
    title: "Reduce Agent Cost per Workspace by 30%",
    descriptionMd: "Optimize model routing, caching, and token budgets to cut per-workspace AI spend.",
    level: "COMPANY",
    cadence: "QUARTERLY",
    status: "ON_TRACK",
    progressPercent: 91,
    targetDate: new Date("2026-05-15"),
  },
];

const SHOWCASE_GOAL_FINANCE_LINKS = [
  {
    goalTitle: "Ship Agent Governance v2",
    projectCode: "ESG-SUPPLIER",
  },
];

const SHOWCASE_AGENTS = [
  {
    agentKey: "slack-agent",
    displayName: "Slack Agent",
    purposeMd: "Interprets natural-language Slack messages and converts them into Corgtex work items or answers workspace knowledge questions.",
  },
  {
    agentKey: "daily-digest",
    displayName: "Daily Digest Agent",
    purposeMd: "Synthesizes organizational activity from conversations, Slack, pull requests, and meetings into personalized daily briefings.",
  },
  {
    agentKey: "meeting-summary",
    displayName: "Meeting Summary Agent",
    purposeMd: "Processes meeting transcripts to extract decisions, action items, and tensions with reviewable evidence.",
  },
  {
    agentKey: "proposal-drafting",
    displayName: "Proposal Drafting Agent",
    purposeMd: "Drafts governance proposals from operator prompts with workspace context and reviewable source grounding.",
  },
  {
    agentKey: "crm-lead-enrichment",
    displayName: "CRM Lead Enrichment Agent",
    purposeMd: "Enriches inbound demo and pilot leads with public company context so the pipeline can be prioritized.",
  },
];

const SHOWCASE_AGENT_RUNS = [
  {
    agentKey: "daily-digest",
    goal: "Generate personalized daily digest for all workspace members",
    status: "COMPLETED",
    triggerType: "SCHEDULE",
    durationMs: 12400,
    hoursAgo: 14,
  },
  {
    agentKey: "slack-agent",
    goal: "Interpret Slack request and create action: follow up with APAC vendor",
    status: "COMPLETED",
    triggerType: "EVENT",
    durationMs: 3200,
    hoursAgo: 10,
  },
  {
    agentKey: "meeting-summary",
    goal: "Extract insights from Weekly Operations Sync transcript",
    status: "COMPLETED",
    triggerType: "EVENT",
    durationMs: 8700,
    hoursAgo: 8,
  },
  {
    agentKey: "proposal-drafting",
    goal: "Draft proposal: async consent for standard governance",
    status: "COMPLETED",
    triggerType: "EVENT",
    durationMs: 4100,
    hoursAgo: 6,
  },
  {
    agentKey: "crm-lead-enrichment",
    goal: "Enrich lead data for Meridian Group using public sources",
    status: "COMPLETED",
    triggerType: "SCHEDULE",
    durationMs: 6500,
    hoursAgo: 4,
  },
  {
    agentKey: "slack-agent",
    goal: "Answer workspace question: What is our current procurement policy?",
    status: "COMPLETED",
    triggerType: "EVENT",
    durationMs: 2800,
    hoursAgo: 2,
  },
  {
    agentKey: "crm-lead-enrichment",
    goal: "Enrich lead data for Horizon Capital Partners",
    status: "WAITING_APPROVAL",
    triggerType: "SCHEDULE",
    durationMs: null,
    hoursAgo: 1,
  },
];

const CRM_ACCOUNTS = [
  {
    slug: "meridian-group",
    name: "Meridian Group",
    domain: "meridian.example",
    relationshipType: "PROSPECT",
    lifecycleStage: "QUALIFIED",
    descriptionMd: "Regional care network evaluating governed AI workspace rollout for clinical operations teams.",
    contacts: [
      { email: "ava.chen@meridian.example", name: "Ava Chen", title: "Chief Operating Officer" },
      { email: "marco.reyes@meridian.example", name: "Marco Reyes", title: "Director of Transformation" },
    ],
    deals: [
      { title: "Clinical operations pilot", stage: "PROPOSAL", valueCents: 18000000, contactEmail: "ava.chen@meridian.example", ownerKey: "jtaubert", stageDaysAgo: 6, notes: "Pilot scope drafted; waiting on compliance review." },
    ],
    activities: [
      { title: "Proposal walkthrough completed", type: "MEETING", bodyMd: "Reviewed pilot success criteria, timeline, and governance checkpoints with operations leadership.", daysAgo: 2 },
      { title: "Send compliance checklist", type: "TASK", dealTitle: "Clinical operations pilot", bodyMd: "Share security and governance checklist before Meridian compliance review.", daysAgo: 1, dueInDays: -1, ownerKey: "jtaubert" },
      { title: "Confirm review attendees", type: "TASK", dealTitle: "Clinical operations pilot", bodyMd: "Confirm Meridian compliance and transformation attendees before the next pilot review.", daysAgo: 0, dueInDays: 3, ownerKey: "demo" },
    ],
    suggestions: [
      {
        title: "Send compliance prep note",
        subject: "Compliance review prep for the clinical operations pilot",
        bodyMd: "Hi Ava,\n\nAhead of the compliance review, here are the governance checkpoints and evidence links we discussed. I suggest we confirm the required reviewers before Friday so the pilot can stay on schedule.",
        contactEmail: "ava.chen@meridian.example",
        dealTitle: "Clinical operations pilot",
        ownerKey: "jtaubert",
        status: "SUGGESTED",
        daysAgo: 0,
      },
      {
        title: "Request attendees through external agent",
        subject: "Confirming compliance review attendees",
        bodyMd: "Hi Marco,\n\nCould you confirm who should join the next review from compliance, transformation, and operations? Corgtex has the agenda ready; we just need the attendee list.",
        contactEmail: "marco.reyes@meridian.example",
        dealTitle: "Clinical operations pilot",
        ownerKey: "demo",
        status: "REQUESTED",
        daysAgo: 1,
      },
    ],
  },
  {
    slug: "horizon-capital-partners",
    name: "Horizon Capital Partners",
    domain: "horizon.example",
    relationshipType: "PARTNER",
    lifecycleStage: "PILOT",
    descriptionMd: "Investment partner exploring Corgtex as a portfolio operating system for AI governance.",
    contacts: [
      { email: "nora.patel@horizon.example", name: "Nora Patel", title: "Operating Partner" },
    ],
    deals: [
      { title: "Portfolio governance advisory", stage: "NEGOTIATION", valueCents: 24000000, contactEmail: "nora.patel@horizon.example", ownerKey: "jwolk", stageDaysAgo: 10, notes: "Commercial terms under review." },
    ],
    activities: [
      { title: "Partner follow-up scheduled", type: "TASK", dealTitle: "Portfolio governance advisory", bodyMd: "Send revised rollout memo and confirm which portfolio companies join the pilot cohort.", daysAgo: 1, dueInDays: 2, ownerKey: "jwolk" },
    ],
    suggestions: [
      {
        title: "Retry portfolio memo follow-up",
        subject: "Revised portfolio governance memo",
        bodyMd: "Hi Nora,\n\nSharing the revised rollout memo and a proposed pilot cohort. If the structure looks right, I can prepare the workspace plan for the first portfolio companies.",
        contactEmail: "nora.patel@horizon.example",
        dealTitle: "Portfolio governance advisory",
        ownerKey: "jwolk",
        status: "FAILED",
        failureReason: "External agent could not access the sender mailbox.",
        daysAgo: 1,
      },
    ],
  },
  {
    slug: "northstar-clinics",
    name: "Northstar Clinics",
    domain: "northstar.example",
    relationshipType: "CLIENT",
    lifecycleStage: "ACTIVE",
    descriptionMd: "Active client using Corgtex for cross-functional project governance and meeting intelligence.",
    contacts: [
      { email: "elena.morris@northstar.example", name: "Elena Morris", title: "VP Operations" },
    ],
    deals: [
      { title: "Expansion workspace rollout", stage: "CLOSED_WON", valueCents: 32000000, contactEmail: "elena.morris@northstar.example", ownerKey: "demo", stageDaysAgo: 18, notes: "Expansion approved for three departments." },
    ],
    activities: [
      { title: "Expansion kickoff notes", type: "NOTE", bodyMd: "Client wants finance visibility and follow-up reminders in the next implementation phase.", daysAgo: 4 },
      { title: "Send expansion recap", type: "TASK", dealTitle: "Expansion workspace rollout", bodyMd: "Recap kickoff decisions and confirm budget owner for the expansion workspace.", daysAgo: 3, dueInDays: -2, ownerKey: "demo", completedDaysAgo: 1 },
    ],
    suggestions: [
      {
        title: "Expansion kickoff recap",
        subject: "Expansion rollout recap and budget owner",
        bodyMd: "Hi Elena,\n\nThanks for the kickoff. We captured the workspace expansion decisions and the open question about budget ownership. I marked the recap as sent so the account timeline has the touchpoint.",
        contactEmail: "elena.morris@northstar.example",
        dealTitle: "Expansion workspace rollout",
        ownerKey: "demo",
        status: "SENT",
        daysAgo: 2,
      },
      {
        title: "Declined renewal nudge",
        subject: "Renewal check-in timing",
        bodyMd: "Hi Elena,\n\nA renewal timing note was drafted but declined because the expansion kickoff recap already covered the next-step timing.",
        contactEmail: "elena.morris@northstar.example",
        dealTitle: "Expansion workspace rollout",
        ownerKey: "demo",
        status: "DECLINED",
        daysAgo: 1,
      },
    ],
  },
];

const SHOWCASE_AUDIT_EVENTS = [
  { action: "proposal.published", entityType: "Proposal" },
  { action: "action.created", entityType: "Action" },
  { action: "tension.published", entityType: "Tension" },
  { action: "meeting.agenda.posted", entityType: "Meeting" },
  { action: "agent.run.completed", entityType: "AgentRun" },
  { action: "brain.article.updated", entityType: "BrainArticle" },
  { action: "action.status.changed", entityType: "Action" },
  { action: "recognition.created", entityType: "Recognition" },
  { action: "agent.run.waiting_approval", entityType: "AgentRun" },
  { action: "goal.progress.updated", entityType: "Goal" },
];

const CONSTITUTION = `# Our Credo & Organizational Constitution

## Mission
To help people be well at every age and every stage of life, through the power of Innovative Medicine and MedTech.

## Vision
To deeply integrate science, technology, and purpose to tackle the world's most complex healthcare challenges.

## Purpose
Rooted in Our Credo, we put the needs and well-being of the people we serve first.

---

## 10 Organizational Principles

### 1. Patient & Customer First
Our first responsibility is to the patients, doctors, nurses, and all who use our products. Quality and safety are paramount.

### 2. Employee Dignity
We respect the dignity and recognize the merit of all our employees. Compensation must be fair, and working conditions clean, orderly, and safe.

### 3. Decentralized Agility
We organize in decentralized units (Innovative Medicine and MedTech) to maintain agility, responsiveness, and closeness to our local markets.

### 4. Community Responsibility
We are responsible to the communities in which we live and work. We must support good works and charities, and protect the environment and natural resources.

### 5. Fair Shareholder Return
When we operate according to these principles, our business must make a sound profit, generating a fair return for our stockholders.

### 6. Continuous Innovation
Research must be carried on, innovative programs developed, and mistakes paid for. We prioritize R&D capital allocation above all else.

### 7. Transparent Governance
Our Regulatory Compliance & Sustainability Committee (RCSC) ensures we hold ourselves to the highest ethical and reporting standards.

### 8. Diverse Leadership
We must provide competent management, whose actions must be just and ethical, representing diverse backgrounds and perspectives.

### 9. Supplier Partnership
We must work with our suppliers and distributors to ensure they share our commitment to ESG and ethical business practices.

### 10. Courageous Investment
New equipment must be purchased, new facilities provided, and new products launched. We must prepare for adverse times while investing boldly in the future.
`;

async function seedShowcaseData({ wsId, memberMappings }) {
  const admin = memberMappings["jduato"] ?? memberMappings["demo"];
  const activeMembers = Object.values(memberMappings);

  for (const [index, goal] of SHOWCASE_GOALS.entries()) {
    const goalId = `${wsId}-goal-${slugify(goal.title)}`;
    const existing = await prisma.goal.findFirst({
      where: { workspaceId: wsId, title: goal.title },
    });
    const data = {
      workspaceId: wsId,
      title: goal.title,
      descriptionMd: goal.descriptionMd,
      level: goal.level,
      cadence: goal.cadence,
      status: goal.status,
      progressPercent: goal.progressPercent,
      targetDate: goal.targetDate,
      ownerMemberId: admin.memberId,
      sortOrder: index,
      archivedAt: null,
      archivedByUserId: null,
      archiveReason: null,
    };

    if (existing) {
      await prisma.goal.update({ where: { id: existing.id }, data });
    } else {
      await prisma.goal.upsert({
        where: { id: goalId },
        update: data,
        create: { id: goalId, ...data },
      });
    }
  }
  console.log(`✅ ${SHOWCASE_GOALS.length} Goals refreshed`);

  for (const link of SHOWCASE_GOAL_FINANCE_LINKS) {
    const goal = await prisma.goal.findFirst({
      where: { workspaceId: wsId, title: link.goalTitle },
      select: { id: true },
    });
    const project = await prisma.practiceProject.findFirst({
      where: { workspaceId: wsId, code: link.projectCode },
      select: { id: true },
    });
    if (goal && project) {
      await prisma.goalLink.upsert({
        where: {
          goalId_entityType_entityId: {
            goalId: goal.id,
            entityType: "PracticeProject",
            entityId: project.id,
          },
        },
        update: {
          confidence: 1,
          linkedBy: "demo-seed",
          source: "practice-finance",
        },
        create: {
          goalId: goal.id,
          entityType: "PracticeProject",
          entityId: project.id,
          confidence: 1,
          linkedBy: "demo-seed",
          source: "practice-finance",
        },
      });
    }
  }
  console.log(`✅ ${SHOWCASE_GOAL_FINANCE_LINKS.length} Goal finance links refreshed`);

  for (const agent of SHOWCASE_AGENTS) {
    await prisma.agentIdentity.upsert({
      where: { workspaceId_agentKey: { workspaceId: wsId, agentKey: agent.agentKey } },
      update: {
        displayName: agent.displayName,
        purposeMd: agent.purposeMd,
        memberType: "INTERNAL",
        isActive: true,
        archivedAt: null,
        archivedByUserId: null,
        archiveReason: null,
      },
      create: {
        id: `${wsId}-agent-${slugify(agent.agentKey)}`,
        workspaceId: wsId,
        agentKey: agent.agentKey,
        displayName: agent.displayName,
        purposeMd: agent.purposeMd,
        memberType: "INTERNAL",
        isActive: true,
        createdByUserId: admin.userId,
      },
    });
  }
  console.log(`✅ ${SHOWCASE_AGENTS.length} Agent identities refreshed`);

  const now = new Date();
  for (const [index, agentRun] of SHOWCASE_AGENT_RUNS.entries()) {
    const runId = `${wsId}-showcase-run-${slugify(agentRun.agentKey)}-${index + 1}`;
    const startedAt = new Date(now.getTime() - agentRun.hoursAgo * 60 * 60 * 1000);
    const completedAt = agentRun.durationMs
      ? new Date(startedAt.getTime() + agentRun.durationMs)
      : null;

    const run = await prisma.agentRun.upsert({
      where: { id: runId },
      update: {
        agentKey: agentRun.agentKey,
        goal: agentRun.goal,
        status: agentRun.status,
        triggerType: agentRun.triggerType,
        triggerRef: `seed-jnj-showcase-${index + 1}`,
        approvalRequired: agentRun.status === "WAITING_APPROVAL",
        startedAt,
        completedAt,
        failedAt: null,
        resultJson: agentRun.status === "COMPLETED"
          ? { status: "success", itemsProcessed: index + 3 }
          : null,
      },
      create: {
        id: runId,
        workspaceId: wsId,
        agentKey: agentRun.agentKey,
        goal: agentRun.goal,
        status: agentRun.status,
        triggerType: agentRun.triggerType,
        triggerRef: `seed-jnj-showcase-${index + 1}`,
        approvalRequired: agentRun.status === "WAITING_APPROVAL",
        startedAt,
        completedAt,
        resultJson: agentRun.status === "COMPLETED"
          ? { status: "success", itemsProcessed: index + 3 }
          : null,
      },
    });

    if (agentRun.status === "COMPLETED" && agentRun.durationMs) {
      const stepNames = ["Load context", "Extract intent", "Execute action", "Deliver result"];
      const stepDuration = Math.floor(agentRun.durationMs / stepNames.length);
      const stepIds = stepNames.map((_, stepIndex) => `${runId}-step-${stepIndex + 1}`);
      await prisma.agentStep.deleteMany({
        where: { agentRunId: run.id, id: { notIn: stepIds } },
      });
      for (const [stepIndex, name] of stepNames.entries()) {
        const stepId = stepIds[stepIndex];
        const data = {
          agentRunId: run.id,
          name,
          status: "COMPLETED",
          startedAt: new Date(startedAt.getTime() + stepIndex * stepDuration),
          completedAt: new Date(startedAt.getTime() + (stepIndex + 1) * stepDuration),
          outputJson: { step: stepIndex + 1, result: "ok" },
        };
        await prisma.agentStep.upsert({
          where: { id: stepId },
          update: data,
          create: { id: stepId, ...data },
        });
      }

      const toolCallNames = [
        "context.load_workspace",
        "model.extract_intent",
        agentRun.agentKey === "slack-agent" ? "slack.post_reply" : "corgtex.create_entity",
      ];
      const toolCallIds = toolCallNames.map((_, toolIndex) => `${runId}-tool-${toolIndex + 1}`);
      await prisma.agentToolCall.deleteMany({
        where: { agentRunId: run.id, id: { notIn: toolCallIds } },
      });
      for (const [toolIndex, name] of toolCallNames.entries()) {
        const toolCallId = toolCallIds[toolIndex];
        const data = {
          agentRunId: run.id,
          name,
          status: "COMPLETED",
          inputJson: { source: "demo", step: toolIndex },
          outputJson: { result: "ok", items: toolIndex + 1 },
          startedAt: new Date(startedAt.getTime() + toolIndex * 1200),
          completedAt: new Date(startedAt.getTime() + toolIndex * 1200 + 450 + toolIndex * 175),
        };
        await prisma.agentToolCall.upsert({
          where: { id: toolCallId },
          update: data,
          create: { id: toolCallId, ...data },
        });
      }

      const modelUsageId = `${runId}-usage`;
      await prisma.modelUsage.deleteMany({
        where: { agentRunId: run.id, id: { notIn: [modelUsageId] } },
      });
      const data = {
        workspaceId: wsId,
        agentRunId: run.id,
        provider: "openrouter",
        model: "qwen/qwen3-32b",
        taskType: "AGENT",
        inputTokens: 800 + index * 325,
        outputTokens: 220 + index * 140,
        latencyMs: agentRun.durationMs,
        estimatedCostUsd: Number((0.0025 + index * 0.0011).toFixed(6)),
      };
      await prisma.modelUsage.upsert({
        where: { id: modelUsageId },
        update: data,
        create: { id: modelUsageId, ...data },
      });
    } else {
      await prisma.agentStep.deleteMany({ where: { agentRunId: run.id } });
      await prisma.agentToolCall.deleteMany({ where: { agentRunId: run.id } });
      await prisma.modelUsage.deleteMany({ where: { agentRunId: run.id } });
    }
  }
  console.log(`✅ ${SHOWCASE_AGENT_RUNS.length} Agent runs refreshed`);

  if (activeMembers.length >= 2) {
    const recognitionId = `${wsId}-recognition-exceptional-systems-thinking`;
    const existing = await prisma.recognition.findFirst({
      where: { workspaceId: wsId, title: "Exceptional Systems Thinking" },
    });
    const data = {
      workspaceId: wsId,
      authorMemberId: activeMembers.find((member) => member.memberId !== admin.memberId)?.memberId ?? admin.memberId,
      recipientMemberId: admin.memberId,
      title: "Exceptional Systems Thinking",
      storyMd: "For building the agent governance system end-to-end. The observability traces and spend controls give leaders confidence in the AI workforce.",
      valueTags: ["INNOVATION", "SPEED", "LEADERSHIP"],
      visibility: "WORKSPACE",
    };

    if (existing) {
      await prisma.recognition.update({ where: { id: existing.id }, data });
    } else {
      await prisma.recognition.upsert({
        where: { id: recognitionId },
        update: data,
        create: { id: recognitionId, ...data },
      });
    }
  }

  for (const [index, event] of SHOWCASE_AUDIT_EVENTS.entries()) {
    await prisma.auditLog.upsert({
      where: { id: `${wsId}-showcase-audit-${slugify(event.action)}` },
      update: {
        actorUserId: activeMembers[index % activeMembers.length]?.userId ?? admin.userId,
        action: event.action,
        entityType: event.entityType,
        entityId: `${wsId}-showcase-entity-${index + 1}`,
        meta: { source: "seed-jnj-demo", showcase: true },
        createdAt: new Date(now.getTime() - index * 30 * 60 * 1000),
      },
      create: {
        id: `${wsId}-showcase-audit-${slugify(event.action)}`,
        workspaceId: wsId,
        actorUserId: activeMembers[index % activeMembers.length]?.userId ?? admin.userId,
        action: event.action,
        entityType: event.entityType,
        entityId: `${wsId}-showcase-entity-${index + 1}`,
        meta: { source: "seed-jnj-demo", showcase: true },
        createdAt: new Date(now.getTime() - index * 30 * 60 * 1000),
      },
    });
  }
  console.log(`✅ ${SHOWCASE_AUDIT_EVENTS.length} Audit events refreshed`);
}

async function enableWorkspaceFeature(wsId, flag) {
  await prisma.workspaceFeatureFlag.upsert({
    where: {
      workspaceId_flag: {
        workspaceId: wsId,
        flag,
      },
    },
    update: { enabled: true },
    create: {
      workspaceId: wsId,
      flag,
      enabled: true,
    },
  });
}

async function seedCrmRelationships(wsId, memberMappings) {
  for (const accountSpec of CRM_ACCOUNTS) {
    const account = await prisma.crmAccount.upsert({
      where: {
        workspaceId_slug: {
          workspaceId: wsId,
          slug: accountSpec.slug,
        },
      },
      update: {
        name: accountSpec.name,
        domain: accountSpec.domain,
        relationshipType: accountSpec.relationshipType,
        lifecycleStage: accountSpec.lifecycleStage,
        descriptionMd: accountSpec.descriptionMd,
        source: "demo_seed",
        archivedAt: null,
        archivedByUserId: null,
        archiveReason: null,
      },
      create: {
        workspaceId: wsId,
        slug: accountSpec.slug,
        name: accountSpec.name,
        domain: accountSpec.domain,
        relationshipType: accountSpec.relationshipType,
        lifecycleStage: accountSpec.lifecycleStage,
        descriptionMd: accountSpec.descriptionMd,
        source: "demo_seed",
      },
    });

    const contactsByEmail = new Map();
    for (const contactSpec of accountSpec.contacts) {
      const contact = await prisma.crmContact.upsert({
        where: {
          workspaceId_email: {
            workspaceId: wsId,
            email: contactSpec.email,
          },
        },
        update: {
          accountId: account.id,
          name: contactSpec.name,
          company: account.name,
          title: contactSpec.title,
          source: "demo_seed",
          archivedAt: null,
          archivedByUserId: null,
          archiveReason: null,
        },
        create: {
          workspaceId: wsId,
          accountId: account.id,
          email: contactSpec.email,
          name: contactSpec.name,
          company: account.name,
          title: contactSpec.title,
          source: "demo_seed",
        },
      });
      contactsByEmail.set(contact.email, contact);
    }

    const dealsByTitle = new Map();
    for (const dealSpec of accountSpec.deals) {
      const contact = contactsByEmail.get(dealSpec.contactEmail);
      if (!contact) continue;
      const dealId = `${wsId}-crm-deal-${slugify(accountSpec.slug)}-${slugify(dealSpec.title)}`;
      const ownerUserId = dealSpec.ownerKey ? memberMappings[dealSpec.ownerKey]?.userId ?? null : null;
      const deal = await prisma.crmDeal.upsert({
        where: { id: dealId },
        update: {
          accountId: account.id,
          contactId: contact.id,
          title: dealSpec.title,
          stage: dealSpec.stage,
          valueCents: dealSpec.valueCents,
          currency: "USD",
          ownerUserId,
          notes: dealSpec.notes,
          closedAt: dealSpec.stage === "CLOSED_WON" || dealSpec.stage === "CLOSED_LOST" ? nDaysAgo(8) : null,
          archivedAt: null,
          archivedByUserId: null,
          archiveReason: null,
        },
        create: {
          id: dealId,
          workspaceId: wsId,
          accountId: account.id,
          contactId: contact.id,
          title: dealSpec.title,
          stage: dealSpec.stage,
          valueCents: dealSpec.valueCents,
          currency: "USD",
          ownerUserId,
          notes: dealSpec.notes,
          closedAt: dealSpec.stage === "CLOSED_WON" || dealSpec.stage === "CLOSED_LOST" ? nDaysAgo(8) : null,
        },
      });
      dealsByTitle.set(deal.title, deal);

      await prisma.crmDealStageTransition.upsert({
        where: { id: `${dealId}-initial-stage` },
        update: {
          fromStage: null,
          toStage: dealSpec.stage,
          actorUserId: ownerUserId,
          createdAt: nDaysAgo(dealSpec.stageDaysAgo ?? 14),
        },
        create: {
          id: `${dealId}-initial-stage`,
          workspaceId: wsId,
          dealId: deal.id,
          fromStage: null,
          toStage: dealSpec.stage,
          actorUserId: ownerUserId,
          createdAt: nDaysAgo(dealSpec.stageDaysAgo ?? 14),
        },
      });
    }

    for (const activitySpec of accountSpec.activities) {
      const deal = activitySpec.dealTitle ? dealsByTitle.get(activitySpec.dealTitle) : null;
      const activityId = `${wsId}-crm-activity-${slugify(accountSpec.slug)}-${slugify(activitySpec.title)}`;
      const ownerUserId = activitySpec.ownerKey ? memberMappings[activitySpec.ownerKey]?.userId ?? null : null;
      const completedAt = Number.isFinite(activitySpec.completedDaysAgo) ? nDaysAgo(activitySpec.completedDaysAgo) : null;
      const dueAt = Number.isFinite(activitySpec.dueInDays) ? nDaysFromNow(activitySpec.dueInDays) : null;
      await prisma.crmActivity.upsert({
        where: { id: activityId },
        update: {
          accountId: account.id,
          contactId: null,
          dealId: deal?.id ?? null,
          type: activitySpec.type,
          title: activitySpec.title,
          bodyMd: activitySpec.bodyMd,
          ownerUserId,
          source: "demo_seed",
          dueAt,
          completedAt,
          completedByUserId: completedAt ? ownerUserId : null,
          createdAt: nDaysAgo(activitySpec.daysAgo),
        },
        create: {
          id: activityId,
          workspaceId: wsId,
          accountId: account.id,
          contactId: null,
          dealId: deal?.id ?? null,
          type: activitySpec.type,
          title: activitySpec.title,
          bodyMd: activitySpec.bodyMd,
          ownerUserId,
          source: "demo_seed",
          dueAt,
          completedAt,
          completedByUserId: completedAt ? ownerUserId : null,
          createdAt: nDaysAgo(activitySpec.daysAgo),
        },
      });
    }

    for (const suggestionSpec of accountSpec.suggestions ?? []) {
      const contact = suggestionSpec.contactEmail ? contactsByEmail.get(suggestionSpec.contactEmail) : null;
      const deal = suggestionSpec.dealTitle ? dealsByTitle.get(suggestionSpec.dealTitle) : null;
      const ownerUserId = suggestionSpec.ownerKey ? memberMappings[suggestionSpec.ownerKey]?.userId ?? null : null;
      const suggestionId = `${wsId}-crm-suggestion-${slugify(accountSpec.slug)}-${slugify(suggestionSpec.title)}`;
      const createdAt = nDaysAgo(suggestionSpec.daysAgo ?? 0);
      const isRequested = suggestionSpec.status === "REQUESTED" || suggestionSpec.status === "FAILED" || suggestionSpec.status === "SENT";
      const requestedAt = isRequested ? createdAt : null;
      const sentAt = suggestionSpec.status === "SENT" ? createdAt : null;
      const failedAt = suggestionSpec.status === "FAILED" ? createdAt : null;
      const declinedAt = suggestionSpec.status === "DECLINED" ? createdAt : null;
      await prisma.crmCommunicationSuggestion.upsert({
        where: { id: suggestionId },
        update: {
          accountId: account.id,
          contactId: contact?.id ?? null,
          dealId: deal?.id ?? null,
          ownerUserId,
          status: suggestionSpec.status,
          channel: "EMAIL",
          title: suggestionSpec.title,
          subject: suggestionSpec.subject,
          bodyMd: suggestionSpec.bodyMd,
          recipientEmail: contact?.email ?? null,
          recipientName: contact?.name ?? null,
          source: "demo_seed",
          requestedAt,
          sentAt,
          declinedAt,
          failedAt,
          failureReason: suggestionSpec.failureReason ?? null,
          externalRequestId: isRequested ? `${suggestionId}-external` : null,
        },
        create: {
          id: suggestionId,
          workspaceId: wsId,
          accountId: account.id,
          contactId: contact?.id ?? null,
          dealId: deal?.id ?? null,
          ownerUserId,
          status: suggestionSpec.status,
          channel: "EMAIL",
          title: suggestionSpec.title,
          subject: suggestionSpec.subject,
          bodyMd: suggestionSpec.bodyMd,
          recipientEmail: contact?.email ?? null,
          recipientName: contact?.name ?? null,
          source: "demo_seed",
          requestedAt,
          sentAt,
          declinedAt,
          failedAt,
          failureReason: suggestionSpec.failureReason ?? null,
          externalRequestId: isRequested ? `${suggestionId}-external` : null,
          createdAt,
        },
      });
    }
  }
}

async function seedContextMapData({ wsId, circleMappings, memberMappings, meetingMappings }) {
  await enableWorkspaceFeature(wsId, "CONTEXT_MAPS");

  const aiMeeting = meetingMappings["Innovation & AI Working Group Kickoff"];
  const rdCircleId = circleMappings["rd"];
  const medtechCircleId = circleMappings["medtech"];
  const boardCircleId = circleMappings["board"];

  const processObjectSpecs = [
    {
      id: `${wsId}-ctx-process-ai-governance`,
      objectType: "Process",
      title: "AI governance critical path",
      summary: "A safe demo process for moving AI ideas from meeting notes into reviewed operating context.",
      properties: {
        criticalPath: true,
        pathStage: "Process",
        nextAction: "Review the blocked charter task and decide who owns MedTech transferability.",
      },
      sourceEntityType: "DemoContext",
      sourceEntityId: "ai-governance-process",
      x: 0,
      y: 96,
    },
    {
      id: `${wsId}-ctx-step-working-group`,
      objectType: "ProcessStep",
      title: "Working group captures opportunity",
      summary: "R&D and MedTech leaders capture AI opportunities from the kickoff meeting.",
      properties: {
        criticalPath: true,
        pathStage: "1. Capture",
        workState: "complete",
      },
      sourceEntityType: "Meeting",
      sourceEntityId: aiMeeting?.id ?? "innovation-ai-working-group",
      x: 280,
      y: 0,
    },
    {
      id: `${wsId}-ctx-step-review-request`,
      objectType: "ProcessStep",
      title: "Review AI governance request",
      summary: "The request is reviewed for operating-model impact, owner clarity, and evidence quality.",
      properties: {
        criticalPath: true,
        pathStage: "2. Review",
        workState: "in_progress",
        nextAction: "Resolve MedTech transferability before approving the charter.",
      },
      sourceEntityType: "DemoContext",
      sourceEntityId: "ai-governance-review-step",
      x: 280,
      y: 176,
    },
    {
      id: `${wsId}-ctx-decision-coe`,
      objectType: "Decision",
      title: "Create R&D AI Center of Excellence",
      summary: "The working group agreed to establish a shared AI Center of Excellence to standardize tooling.",
      confidence: 0.93,
      properties: {
        criticalPath: true,
        pathStage: "Decision",
        workState: "approved",
      },
      sourceEntityType: "MeetingInsight",
      sourceEntityId: `${wsId}-insight-applied-ai-coe-decision`,
      x: 560,
      y: 0,
    },
    {
      id: `${wsId}-ctx-task-charter`,
      objectType: "Task",
      title: "Draft AI governance working-group charter",
      summary: "In-progress follow-up to circulate a charter before the next R&D review.",
      confidence: 0.72,
      properties: {
        criticalPath: true,
        pathStage: "Execution",
        workState: "in_progress",
        nextAction: "Add MedTech transferability risk owner and blocker mitigation before review.",
      },
      sourceEntityType: "MeetingInsight",
      sourceEntityId: `${wsId}-insight-needs-review-ai-governance`,
      x: 560,
      y: 190,
    },
    {
      id: `${wsId}-ctx-team-rd`,
      objectType: "Team",
      title: "Research & Development",
      summary: "Cross-cutting R&D strategy and pipeline management.",
      properties: {
        pathStage: "Owner",
      },
      sourceEntityType: "Circle",
      sourceEntityId: rdCircleId,
      x: 280,
      y: 352,
    },
    {
      id: `${wsId}-ctx-team-medtech`,
      objectType: "Team",
      title: "MedTech",
      summary: "Medical devices, surgical solutions, and vision.",
      properties: {
        pathStage: "Approver",
      },
      sourceEntityType: "Circle",
      sourceEntityId: medtechCircleId,
      x: 820,
      y: 176,
    },
    {
      id: `${wsId}-ctx-risk-digital-twin`,
      objectType: "Risk",
      title: "Digital twin transferability is unclear",
      summary: "The transcript hints that MedTech digital twin pilots may need separate governance, but ownership is not yet clear.",
      confidence: 0.38,
      status: "proposed",
      properties: {
        criticalPath: true,
        pathStage: "Blocker",
        workState: "blocked",
        nextAction: "Name a MedTech owner and decide whether digital twin pilots follow the same COE review.",
      },
      sourceEntityType: "MeetingInsight",
      sourceEntityId: `${wsId}-insight-low-confidence-digital-twin`,
      x: 820,
      y: 0,
    },
    {
      id: `${wsId}-ctx-meeting-ai-kickoff`,
      objectType: "Meeting",
      title: "Innovation & AI Working Group Kickoff",
      summary: "Discussed AI governance, drug discovery ML platforms, and digital twin pilots.",
      properties: {
        pathStage: "Meeting evidence",
      },
      sourceEntityType: "Meeting",
      sourceEntityId: aiMeeting?.id ?? "innovation-ai-working-group",
      x: 0,
      y: 300,
    },
    {
      id: `${wsId}-ctx-tool-mcp-smoke`,
      objectType: "Tool",
      title: "Production smoke check",
      summary: "Control-plane smoke check that agents can use as evidence before suggesting map changes.",
      confidence: 0.82,
      properties: {
        pathStage: "Control",
        workState: "ready",
      },
      sourceEntityType: "DemoContext",
      sourceEntityId: "mcp-production-smoke",
      x: 820,
      y: 352,
    },
    {
      id: `${wsId}-ctx-team-executive`,
      objectType: "Team",
      title: "Executive Committee",
      summary: "Company-wide governance and strategic oversight.",
      properties: {
        pathStage: "Governance",
      },
      sourceEntityType: "Circle",
      sourceEntityId: boardCircleId,
      x: 280,
      y: 528,
    },
  ];

  const orgCircleId = (circleId) => `${wsId}-ctx-org-circle-${circleId}`;
  const orgRoleId = (role) => `${wsId}-ctx-org-role-${role.circle}-${slugify(role.name)}`;
  const orgPersonId = (memberKey) => `${wsId}-ctx-org-person-${memberKey}`;
  const segmentCircleIds = CIRCLES.filter((circle) => circle.id !== "board").map((circle) => circle.id);
  const roleCountByCircle = new Map();
  const personLayoutByMemberKey = new Map();
  const memberByKey = new Map(TEAM_MEMBERS.map((member) => [member.email.split("@")[0], member]));

  function circlePosition(circleId) {
    if (circleId === "board") return { x: 560, y: 0 };
    return { x: segmentCircleIds.indexOf(circleId) * 340, y: 510 };
  }

  function rolePosition(circleId, index) {
    if (circleId === "board") return { x: index * 280, y: 170 };
    return { x: segmentCircleIds.indexOf(circleId) * 340, y: 680 + index * 150 };
  }

  const orgCircleSpecs = CIRCLES.map((circle) => ({
    id: orgCircleId(circle.id),
    objectType: "Team",
    title: circle.name,
    summary: circle.purpose,
    properties: {
      orgView: true,
      orgKind: "Circle",
      pathStage: circle.id === "board" ? "Enterprise circle" : "Operating circle",
      sourceSystem: "workspace.circle",
    },
    sourceEntityType: "Circle",
    sourceEntityId: circleMappings[circle.id],
    ...circlePosition(circle.id),
  }));

  const orgRoleSpecs = ROLES.map((role) => {
    const index = roleCountByCircle.get(role.circle) ?? 0;
    roleCountByCircle.set(role.circle, index + 1);
    const position = rolePosition(role.circle, index);
    if (role.assignee && !personLayoutByMemberKey.has(role.assignee)) {
      const personIndex = personLayoutByMemberKey.size;
      personLayoutByMemberKey.set(role.assignee, {
        x: (personIndex % 5) * 340,
        y: 1500 + Math.floor(personIndex / 5) * 150,
        roleTitles: [],
      });
    }
    if (role.assignee) {
      personLayoutByMemberKey.get(role.assignee)?.roleTitles.push(role.name);
    }
    return {
      id: orgRoleId(role),
      objectType: "Role",
      title: role.name,
      summary: role.purpose,
      properties: {
        orgView: true,
        orgKind: "Role",
        pathStage: "Accountability",
        staffingState: role.assignee ? "assigned" : "open",
        accountabilities: role.accountabilities,
        ...(role.assignee ? {} : { nextAction: `Assign a member to own ${role.name}.` }),
      },
      sourceEntityType: "Role",
      sourceEntityId: `${circleMappings[role.circle]}-role-${slugify(role.name)}`,
      ...position,
    };
  });

  const orgPersonSpecs = [...personLayoutByMemberKey.entries()].map(([memberKey, layout]) => {
    const member = memberByKey.get(memberKey);
    return {
      id: orgPersonId(memberKey),
      objectType: "Person",
      title: member?.name ?? memberKey,
      summary: member?.title ?? "Workspace member",
      properties: {
        orgView: true,
        orgKind: "Person",
        pathStage: "Member",
        staffingState: "assigned",
        assignedRoles: layout.roleTitles,
      },
      sourceEntityType: "Member",
      sourceEntityId: memberMappings[memberKey]?.memberId ?? memberKey,
      x: layout.x,
      y: layout.y,
    };
  });

  const orgObjectSpecs = [...orgCircleSpecs, ...orgRoleSpecs, ...orgPersonSpecs];
  const agentObjectId = (key) => `${wsId}-ctx-agent-${key}`;
  const agentObjectSpecs = [
    {
      id: agentObjectId("input-meeting-transcript"),
      objectType: "Meeting",
      title: "Meeting transcript source",
      summary: "Meeting notes that can suggest decisions, actions, and tensions before anything is added to the approved map.",
      properties: {
        governanceView: true,
        pathStage: "Input",
        dataFlow: "Transcript snippets are treated as supporting evidence until a human approves a map change.",
        governanceControls: ["Snippet-level evidence required", "Workspace membership checked before read"],
      },
      sourceEntityType: "Meeting",
      sourceEntityId: aiMeeting?.id ?? "innovation-ai-working-group",
      x: 0,
      y: 0,
    },
    {
      id: agentObjectId("input-brain-articles"),
      objectType: "Document",
      title: "Brain articles and documents",
      summary: "Reference records that support or challenge what the map shows.",
      properties: {
        governanceView: true,
        pathStage: "Input",
        dataFlow: "Reference material is kept as supporting evidence until a human approves any map change.",
        governanceControls: ["Original record retained", "Evidence quote shown in inspector"],
      },
      sourceEntityType: "BRAIN_ARTICLE",
      sourceEntityId: "capital-allocation-framework",
      x: 0,
      y: 180,
    },
    {
      id: agentObjectId("input-audit-trail"),
      objectType: "Evidence",
      title: "Audit and run records",
      summary: "Agent runs, tool calls, and audit events explain what happened during a proposal path.",
      properties: {
        governanceView: true,
        pathStage: "Input",
        dataFlow: "Operational records feed traceability and controls, not autonomous truth mutation.",
        governanceControls: ["Run id retained", "Tool call output captured"],
      },
      sourceEntityType: "AgentRun",
      sourceEntityId: `${wsId}-showcase-run-meeting-summary-3`,
      x: 0,
      y: 360,
    },
    {
      id: agentObjectId("region-context-agent"),
      objectType: "Agent",
      title: "Region Context Agent",
      summary: "When someone selects part of the map, this agent gathers the relevant background so answers stay scoped and safe.",
      properties: {
        governanceView: true,
        pathStage: "Agent",
        allowedActions: ["Read the selected map area", "Find supporting evidence", "Return open questions"],
        governanceControls: ["Scoped to selected map region", "No write scope"],
      },
      sourceEntityType: "AgentIdentity",
      sourceEntityId: `${wsId}-agent-daily-digest`,
      x: 360,
      y: 85,
    },
    {
      id: agentObjectId("diff-proposal-agent"),
      objectType: "Agent",
      title: "Graph Diff Proposal Agent",
      summary: "Suggests missing work, owners, risks, or approval links from the selected map area for human review.",
      properties: {
        governanceView: true,
        pathStage: "Agent",
        allowedActions: ["Suggest map changes", "Explain evidence", "Flag missing owners, tasks, and risks"],
        governanceControls: ["Can only suggest changes", "Cannot apply approved changes by itself"],
        approvalRule: "Every change that affects approved company context needs human approval.",
      },
      sourceEntityType: "AgentIdentity",
      sourceEntityId: `${wsId}-agent-meeting-summary`,
      x: 360,
      y: 280,
    },
    {
      id: agentObjectId("policy-scoped-read"),
      objectType: "Policy",
      title: "Scoped context read policy",
      summary: "Agents may read only the selected map area and the workspace information they are allowed to access.",
      properties: {
        governanceView: true,
        pathStage: "Policy",
        governanceControls: ["Workspace membership required", "Selection scope required", "Permissions included in packet"],
        approvalRule: "Read access is bounded by actor permissions and workspace membership.",
      },
      sourceEntityType: "POLICY_RECORD",
      sourceEntityId: "context-graph-scoped-read",
      x: 720,
      y: 0,
    },
    {
      id: agentObjectId("policy-propose-only"),
      objectType: "Policy",
      title: "Propose-only truth policy",
      summary: "Agent outputs that would change approved company context must wait for human review.",
      properties: {
        governanceView: true,
        pathStage: "Policy",
        governanceControls: ["Proposal required", "Before/after review retained", "No silent changes"],
        approvalRule: "Approved company context remains human or policy controlled.",
      },
      sourceEntityType: "POLICY_RECORD",
      sourceEntityId: "context-graph-propose-only",
      x: 720,
      y: 180,
    },
    {
      id: agentObjectId("policy-human-approval"),
      objectType: "Policy",
      title: "Human approval gate",
      summary: "Admins and facilitators review, edit, approve, or reject proposed graph and map changes.",
      properties: {
        governanceView: true,
        pathStage: "Approval",
        governanceControls: ["Approver role checked", "Audit event recorded", "Applied changes are explicit"],
        approvalRule: "Master map changes require approval.",
      },
      sourceEntityType: "POLICY_RECORD",
      sourceEntityId: "context-graph-human-approval",
      x: 720,
      y: 360,
    },
    {
      id: agentObjectId("tool-context-read"),
      objectType: "Tool",
      title: "Read selected map context",
      summary: "Returns the approved context for the selected map area without changing anything.",
      properties: {
        governanceView: true,
        pathStage: "Tool",
        allowedActions: ["Read the map view", "Read the selected area"],
        governanceControls: ["Read-only scope", "Evidence and source notes returned"],
      },
      sourceEntityType: "MCP_TOOL",
      sourceEntityId: "context-graph.read",
      x: 1080,
      y: 85,
    },
    {
      id: agentObjectId("tool-proposed-diff"),
      objectType: "Tool",
      title: "Write proposed changes",
      summary: "Saves proposed map updates for human review instead of applying them directly.",
      properties: {
        governanceView: true,
        pathStage: "Tool",
        allowedActions: ["Save proposed changes for review", "Attach supporting evidence"],
        governanceControls: ["Pending status by default", "Approval required before apply"],
        approvalRule: "The tool can propose changes but cannot approve them.",
      },
      sourceEntityType: "MCP_TOOL",
      sourceEntityId: "context-graph.propose",
      x: 1080,
      y: 280,
    },
    {
      id: agentObjectId("output-region-context"),
      objectType: "Document",
      title: "Selected map brief",
      summary: "A short brief for the selected area: what matters, what is missing, and what can happen next.",
      properties: {
        governanceView: true,
        pathStage: "Output",
        governanceControls: ["Includes permission summary", "Separates approved, stale, disputed, and proposed facts"],
      },
      sourceEntityType: "ContextPacket",
      sourceEntityId: `${wsId}-agent-region-context-packet`,
      x: 1440,
      y: 0,
    },
    {
      id: agentObjectId("output-proposed-diff"),
      objectType: "Task",
      title: "Proposed missing tasks, risks, and owners",
      summary: "Agent-created proposal that a human can compare, edit, approve, or reject.",
      properties: {
        governanceView: true,
        pathStage: "Output",
        workState: "needs_review",
        nextAction: "Review the proposal before updating the approved map.",
        governanceControls: ["Human review required", "Supporting evidence attached"],
      },
      sourceEntityType: "ContextGraphProposedDiff",
      sourceEntityId: `${wsId}-ctx-agent-demo-diff`,
      x: 1440,
      y: 180,
    },
    {
      id: agentObjectId("output-audit-event"),
      objectType: "Evidence",
      title: "Audit trail event",
      summary: "Trace showing who proposed, reviewed, and applied or rejected the graph change.",
      properties: {
        governanceView: true,
        pathStage: "Output",
        governanceControls: ["Actor recorded", "Proposal id recorded", "Approval outcome recorded"],
      },
      sourceEntityType: "AuditTrail",
      sourceEntityId: "context-graph.proposed-diff.created",
      x: 1440,
      y: 360,
    },
    {
      id: agentObjectId("risk-silent-mutation"),
      objectType: "Risk",
      title: "Silent map update risk",
      summary: "Risk that an agent could make company context look authoritative without evidence or review.",
      properties: {
        governanceView: true,
        pathStage: "Control risk",
        nextAction: "Keep all agent-suggested changes in review until a human approves them.",
        governanceControls: ["Suggestion-only path", "Approval gate", "Audit trail"],
      },
      sourceEntityType: "RISK_REGISTER",
      sourceEntityId: "silent-graph-mutation",
      x: 720,
      y: 540,
    },
  ];
  const processObjectIds = processObjectSpecs.map((object) => object.id);
  const orgObjectIds = orgObjectSpecs.map((object) => object.id);
  const agentObjectIds = agentObjectSpecs.map((object) => object.id);
  const objectSpecs = [...processObjectSpecs, ...orgObjectSpecs, ...agentObjectSpecs];
  const objectIds = objectSpecs.map((object) => object.id);
  await prisma.contextGraphObject.deleteMany({
    where: {
      workspaceId: wsId,
      id: {
        startsWith: `${wsId}-ctx-`,
        notIn: objectIds,
      },
    },
  });

  for (const object of objectSpecs) {
    await prisma.contextGraphObject.upsert({
      where: { id: object.id },
      update: {
        objectType: object.objectType,
        title: object.title,
        summary: object.summary,
        properties: object.properties ?? {},
        confidence: object.confidence ?? null,
        status: object.status ?? "approved",
        sourceEntityType: object.sourceEntityType,
        sourceEntityId: object.sourceEntityId,
        updatedAt: new Date(),
      },
      create: {
        id: object.id,
        workspaceId: wsId,
        objectType: object.objectType,
        title: object.title,
        summary: object.summary,
        properties: object.properties ?? {},
        confidence: object.confidence ?? null,
        status: object.status ?? "approved",
        createdByType: "integration",
        sourceEntityType: object.sourceEntityType,
        sourceEntityId: object.sourceEntityId,
        lastVerifiedAt: object.status === "proposed" ? null : new Date(),
      },
    });
  }

  const processMapView = await prisma.contextMapView.upsert({
    where: { id: `${wsId}-ctx-map-process` },
    update: {
      name: "AI governance critical path",
      viewType: "process",
      query: {
        demo: true,
        mode: "criticalPath",
        objectIds: processObjectIds,
        objectTypes: ["Process", "ProcessStep", "Decision", "Task", "Risk", "Team", "Tool", "Meeting"],
        relationshipTypes: ["part_of", "depends_on", "blocks", "owns", "assigned_to", "supports", "uses", "created_in", "decided_in", "needs_approval_from"],
      },
    },
    create: {
      id: `${wsId}-ctx-map-process`,
      workspaceId: wsId,
      name: "AI governance critical path",
      viewType: "process",
      query: {
        demo: true,
        mode: "criticalPath",
        objectIds: processObjectIds,
        objectTypes: ["Process", "ProcessStep", "Decision", "Task", "Risk", "Team", "Tool", "Meeting"],
        relationshipTypes: ["part_of", "depends_on", "blocks", "owns", "assigned_to", "supports", "uses", "created_in", "decided_in", "needs_approval_from"],
      },
    },
  });

  for (const object of processObjectSpecs) {
    await prisma.contextMapLayoutItem.upsert({
      where: {
        mapViewId_objectId: {
          mapViewId: processMapView.id,
          objectId: object.id,
        },
      },
      update: { x: object.x, y: object.y, width: 230, height: 110 },
      create: {
        mapViewId: processMapView.id,
        objectId: object.id,
        x: object.x,
        y: object.y,
        width: 230,
        height: 110,
      },
    });
  }

  const orgMapView = await prisma.contextMapView.upsert({
    where: { id: `${wsId}-ctx-map-org` },
    update: {
      name: "J&J organization map",
      viewType: "org",
      query: {
        demo: true,
        mode: "organization",
        objectIds: orgObjectIds,
        objectTypes: ["Team", "Role", "Person"],
        relationshipTypes: ["part_of", "member_of", "reports_to", "owns"],
      },
    },
    create: {
      id: `${wsId}-ctx-map-org`,
      workspaceId: wsId,
      name: "J&J organization map",
      viewType: "org",
      query: {
        demo: true,
        mode: "organization",
        objectIds: orgObjectIds,
        objectTypes: ["Team", "Role", "Person"],
        relationshipTypes: ["part_of", "member_of", "reports_to", "owns"],
      },
    },
  });

  for (const object of orgObjectSpecs) {
    await prisma.contextMapLayoutItem.upsert({
      where: {
        mapViewId_objectId: {
          mapViewId: orgMapView.id,
          objectId: object.id,
        },
      },
      update: { x: object.x, y: object.y, width: 230, height: 110 },
      create: {
        mapViewId: orgMapView.id,
        objectId: object.id,
        x: object.x,
        y: object.y,
        width: 230,
        height: 110,
      },
    });
  }

  const agentMapView = await prisma.contextMapView.upsert({
    where: { id: `${wsId}-ctx-map-agent` },
    update: {
      name: "J&J agent governance map",
      viewType: "agent",
      query: {
        demo: true,
        mode: "agentGovernance",
        objectIds: agentObjectIds,
        objectTypes: ["Agent", "Policy", "Tool", "Meeting", "Document", "Task", "Risk", "Evidence"],
        relationshipTypes: ["input_to", "output_of", "uses", "supports", "needs_approval_from", "created_in", "has_evidence", "blocks"],
      },
    },
    create: {
      id: `${wsId}-ctx-map-agent`,
      workspaceId: wsId,
      name: "J&J agent governance map",
      viewType: "agent",
      query: {
        demo: true,
        mode: "agentGovernance",
        objectIds: agentObjectIds,
        objectTypes: ["Agent", "Policy", "Tool", "Meeting", "Document", "Task", "Risk", "Evidence"],
        relationshipTypes: ["input_to", "output_of", "uses", "supports", "needs_approval_from", "created_in", "has_evidence", "blocks"],
      },
    },
  });

  for (const object of agentObjectSpecs) {
    await prisma.contextMapLayoutItem.upsert({
      where: {
        mapViewId_objectId: {
          mapViewId: agentMapView.id,
          objectId: object.id,
        },
      },
      update: { x: object.x, y: object.y, width: 240, height: 118 },
      create: {
        mapViewId: agentMapView.id,
        objectId: object.id,
        x: object.x,
        y: object.y,
        width: 240,
        height: 118,
      },
    });
  }

  const processRelationships = [
    { sourceObjectId: `${wsId}-ctx-step-working-group`, targetObjectId: `${wsId}-ctx-process-ai-governance`, relationshipType: "part_of", status: "approved", confidence: 0.9 },
    { sourceObjectId: `${wsId}-ctx-step-review-request`, targetObjectId: `${wsId}-ctx-process-ai-governance`, relationshipType: "part_of", status: "approved", confidence: 0.86 },
    { sourceObjectId: `${wsId}-ctx-meeting-ai-kickoff`, targetObjectId: `${wsId}-ctx-step-working-group`, relationshipType: "supports", status: "approved", confidence: 0.88 },
    { sourceObjectId: `${wsId}-ctx-decision-coe`, targetObjectId: `${wsId}-ctx-meeting-ai-kickoff`, relationshipType: "decided_in", status: "approved", confidence: 0.93 },
    { sourceObjectId: `${wsId}-ctx-decision-coe`, targetObjectId: `${wsId}-ctx-step-review-request`, relationshipType: "supports", status: "approved", confidence: 0.88 },
    { sourceObjectId: `${wsId}-ctx-task-charter`, targetObjectId: `${wsId}-ctx-meeting-ai-kickoff`, relationshipType: "created_in", status: "approved", confidence: 0.72 },
    { sourceObjectId: `${wsId}-ctx-task-charter`, targetObjectId: `${wsId}-ctx-decision-coe`, relationshipType: "depends_on", status: "approved", confidence: 0.82 },
    { sourceObjectId: `${wsId}-ctx-task-charter`, targetObjectId: `${wsId}-ctx-team-rd`, relationshipType: "assigned_to", status: "approved", confidence: 0.84 },
    { sourceObjectId: `${wsId}-ctx-risk-digital-twin`, targetObjectId: `${wsId}-ctx-task-charter`, relationshipType: "blocks", status: "proposed", confidence: 0.38 },
    { sourceObjectId: `${wsId}-ctx-risk-digital-twin`, targetObjectId: `${wsId}-ctx-team-medtech`, relationshipType: "needs_approval_from", status: "proposed", confidence: 0.38 },
    { sourceObjectId: `${wsId}-ctx-team-rd`, targetObjectId: `${wsId}-ctx-process-ai-governance`, relationshipType: "owns", status: "approved", confidence: 0.9 },
    { sourceObjectId: `${wsId}-ctx-tool-mcp-smoke`, targetObjectId: `${wsId}-ctx-process-ai-governance`, relationshipType: "supports", status: "approved", confidence: 0.82 },
    { sourceObjectId: `${wsId}-ctx-team-rd`, targetObjectId: `${wsId}-ctx-team-executive`, relationshipType: "part_of", status: "approved", confidence: 0.95 },
    { sourceObjectId: `${wsId}-ctx-team-medtech`, targetObjectId: `${wsId}-ctx-team-executive`, relationshipType: "part_of", status: "approved", confidence: 0.95 },
  ];

  const ceoRole = ROLES.find((role) => role.circle === "board" && role.name === "Chairman & CEO");
  const leadRoleByCircle = new Map(
    CIRCLES.map((circle) => {
      const lead = ROLES.find((role) => role.circle === circle.id && (
        role.name === "Worldwide Chairman"
        || role.name === "EVP Research & Development"
        || role.name === "Head of Internal Audit"
        || role.name === "Head of Health Equity"
        || role.name === "Chairman & CEO"
      ));
      return [circle.id, lead];
    }),
  );
  const orgRelationships = [
    ...CIRCLES
      .filter((circle) => circle.id !== "board")
      .map((circle) => ({
        sourceObjectId: orgCircleId(circle.id),
        targetObjectId: orgCircleId("board"),
        relationshipType: "part_of",
        status: "approved",
        confidence: 0.94,
        properties: { orgView: true, relationScope: "circle" },
      })),
    ...ROLES.flatMap((role) => {
      const relationshipsForRole = [{
        sourceObjectId: orgRoleId(role),
        targetObjectId: orgCircleId(role.circle),
        relationshipType: "part_of",
        status: "approved",
        confidence: 0.92,
        properties: { orgView: true, relationScope: "role" },
      }];
      if (role.assignee) {
        relationshipsForRole.push({
          sourceObjectId: orgPersonId(role.assignee),
          targetObjectId: orgRoleId(role),
          relationshipType: "member_of",
          status: "approved",
          confidence: 0.9,
          properties: { orgView: true, relationScope: "assignment" },
        });
      }
      const leadRole = leadRoleByCircle.get(role.circle);
      if (leadRole && leadRole !== role) {
        relationshipsForRole.push({
          sourceObjectId: orgRoleId(role),
          targetObjectId: orgRoleId(leadRole),
          relationshipType: "reports_to",
          status: "approved",
          confidence: 0.78,
          properties: { orgView: true, relationScope: "reporting" },
        });
      } else if (role.circle !== "board" && ceoRole) {
        relationshipsForRole.push({
          sourceObjectId: orgRoleId(role),
          targetObjectId: orgRoleId(ceoRole),
          relationshipType: "reports_to",
          status: "approved",
          confidence: 0.72,
          properties: { orgView: true, relationScope: "executive-reporting" },
        });
      }
      if (role.name === "Worldwide Chairman" || role.name === "EVP Research & Development" || role.name === "Chairman & CEO") {
        relationshipsForRole.push({
          sourceObjectId: orgRoleId(role),
          targetObjectId: orgCircleId(role.circle),
          relationshipType: "owns",
          status: "approved",
          confidence: 0.84,
          properties: { orgView: true, relationScope: "accountability" },
        });
      }
      return relationshipsForRole;
    }),
  ];

  const agentRelationships = [
    {
      sourceObjectId: agentObjectId("input-meeting-transcript"),
      targetObjectId: agentObjectId("region-context-agent"),
      relationshipType: "input_to",
      status: "approved",
      confidence: 0.91,
      properties: { governanceView: true, relationScope: "input" },
    },
    {
      sourceObjectId: agentObjectId("input-brain-articles"),
      targetObjectId: agentObjectId("region-context-agent"),
      relationshipType: "input_to",
      status: "approved",
      confidence: 0.88,
      properties: { governanceView: true, relationScope: "input" },
    },
    {
      sourceObjectId: agentObjectId("input-audit-trail"),
      targetObjectId: agentObjectId("diff-proposal-agent"),
      relationshipType: "input_to",
      status: "approved",
      confidence: 0.84,
      properties: { governanceView: true, relationScope: "traceability" },
    },
    {
      sourceObjectId: agentObjectId("region-context-agent"),
      targetObjectId: agentObjectId("tool-context-read"),
      relationshipType: "uses",
      status: "approved",
      confidence: 0.94,
      properties: { governanceView: true, relationScope: "tool-use" },
    },
    {
      sourceObjectId: agentObjectId("diff-proposal-agent"),
      targetObjectId: agentObjectId("tool-context-read"),
      relationshipType: "uses",
      status: "approved",
      confidence: 0.89,
      properties: { governanceView: true, relationScope: "tool-use" },
    },
    {
      sourceObjectId: agentObjectId("diff-proposal-agent"),
      targetObjectId: agentObjectId("tool-proposed-diff"),
      relationshipType: "uses",
      status: "approved",
      confidence: 0.93,
      properties: { governanceView: true, relationScope: "tool-use" },
    },
    {
      sourceObjectId: agentObjectId("policy-scoped-read"),
      targetObjectId: agentObjectId("region-context-agent"),
      relationshipType: "supports",
      status: "approved",
      confidence: 0.92,
      properties: { governanceView: true, relationScope: "policy-control" },
    },
    {
      sourceObjectId: agentObjectId("policy-scoped-read"),
      targetObjectId: agentObjectId("tool-context-read"),
      relationshipType: "supports",
      status: "approved",
      confidence: 0.9,
      properties: { governanceView: true, relationScope: "policy-control" },
    },
    {
      sourceObjectId: agentObjectId("policy-propose-only"),
      targetObjectId: agentObjectId("diff-proposal-agent"),
      relationshipType: "supports",
      status: "approved",
      confidence: 0.92,
      properties: { governanceView: true, relationScope: "policy-control" },
    },
    {
      sourceObjectId: agentObjectId("policy-propose-only"),
      targetObjectId: agentObjectId("tool-proposed-diff"),
      relationshipType: "supports",
      status: "approved",
      confidence: 0.91,
      properties: { governanceView: true, relationScope: "policy-control" },
    },
    {
      sourceObjectId: agentObjectId("policy-human-approval"),
      targetObjectId: agentObjectId("output-proposed-diff"),
      relationshipType: "needs_approval_from",
      status: "approved",
      confidence: 0.9,
      properties: { governanceView: true, relationScope: "approval" },
    },
    {
      sourceObjectId: agentObjectId("output-region-context"),
      targetObjectId: agentObjectId("region-context-agent"),
      relationshipType: "output_of",
      status: "approved",
      confidence: 0.9,
      properties: { governanceView: true, relationScope: "output" },
    },
    {
      sourceObjectId: agentObjectId("output-proposed-diff"),
      targetObjectId: agentObjectId("diff-proposal-agent"),
      relationshipType: "output_of",
      status: "approved",
      confidence: 0.88,
      properties: { governanceView: true, relationScope: "output" },
    },
    {
      sourceObjectId: agentObjectId("output-audit-event"),
      targetObjectId: agentObjectId("output-proposed-diff"),
      relationshipType: "has_evidence",
      status: "approved",
      confidence: 0.86,
      properties: { governanceView: true, relationScope: "audit" },
    },
    {
      sourceObjectId: agentObjectId("risk-silent-mutation"),
      targetObjectId: agentObjectId("output-proposed-diff"),
      relationshipType: "blocks",
      status: "approved",
      confidence: 0.72,
      properties: { governanceView: true, relationScope: "risk-control" },
    },
    {
      sourceObjectId: agentObjectId("policy-human-approval"),
      targetObjectId: agentObjectId("risk-silent-mutation"),
      relationshipType: "supports",
      status: "approved",
      confidence: 0.84,
      properties: { governanceView: true, relationScope: "mitigation" },
    },
  ];

  const relationships = [...processRelationships, ...orgRelationships, ...agentRelationships];

  await prisma.contextGraphRelationship.deleteMany({
    where: {
      workspaceId: wsId,
      createdByType: "integration",
      dedupeKey: { endsWith: ":demo" },
      OR: [
        { sourceObjectId: { startsWith: `${wsId}-ctx-` } },
        { targetObjectId: { startsWith: `${wsId}-ctx-` } },
      ],
    },
  });

  for (const relationship of relationships) {
    const dedupeKey = `${wsId}:${relationship.sourceObjectId}:${relationship.relationshipType}:${relationship.targetObjectId}:demo`;
    await prisma.contextGraphRelationship.create({
      data: {
        workspaceId: wsId,
        sourceObjectId: relationship.sourceObjectId,
        targetObjectId: relationship.targetObjectId,
        relationshipType: relationship.relationshipType,
        status: relationship.status,
        confidence: relationship.confidence,
        properties: relationship.properties ?? { criticalPath: true },
        createdByType: "integration",
        dedupeKey,
      },
    });
  }

  const processEvidenceSpecs = [
    {
      objectId: `${wsId}-ctx-process-ai-governance`,
      quote: "The working group needs a repeatable path from captured notes to governed AI actions.",
      relevanceScore: 0.86,
    },
    {
      objectId: `${wsId}-ctx-step-working-group`,
      quote: "Discussed AI governance, drug discovery ML platforms, and digital twin pilots.",
      relevanceScore: 0.88,
    },
    {
      objectId: `${wsId}-ctx-decision-coe`,
      quote: "Generative AI will change target optimization. We are establishing an internal COE to standardize tooling.",
      relevanceScore: 0.93,
    },
    {
      objectId: `${wsId}-ctx-task-charter`,
      quote: "We are establishing an internal COE to standardize tooling.",
      relevanceScore: 0.72,
    },
    {
      objectId: `${wsId}-ctx-risk-digital-twin`,
      quote: "Discussed AI governance, drug discovery ML platforms, and digital twin pilots.",
      relevanceScore: 0.38,
    },
    {
      objectId: `${wsId}-ctx-tool-mcp-smoke`,
      quote: "Use the read-and-propose path so agents suggest changes without silently updating approved context.",
      relevanceScore: 0.82,
    },
  ];

  const circleEvidenceSourceById = {
    board: "2024 Financial Overview & Strategy",
    "innovative-medicine": "Innovative Medicine Segment",
    medtech: "MedTech Segment",
    rd: "Pipeline & Clinical Trials Overview",
    finance: "Capital Allocation Framework",
    esg: "Health for Humanity Sustainability Goals",
  };
  const orgEvidenceSpecs = [
    ...CIRCLES.map((circle) => ({
      objectId: orgCircleId(circle.id),
      sourceType: "BRAIN_ARTICLE",
      sourceId: slugify(circleEvidenceSourceById[circle.id] ?? "2024 Financial Overview & Strategy"),
      quote: `${circle.name}: ${circle.purpose}.`,
      relevanceScore: 0.82,
    })),
    ...ROLES.map((role) => ({
      objectId: orgRoleId(role),
      sourceType: "ROLE_RECORD",
      sourceId: `${circleMappings[role.circle]}-role-${slugify(role.name)}`,
      quote: role.accountabilities.length
        ? `${role.name} accountability: ${role.accountabilities[0]}.`
        : `${role.name} exists in ${CIRCLES.find((circle) => circle.id === role.circle)?.name ?? role.circle}, but no accountability detail is recorded yet.`,
      relevanceScore: role.accountabilities.length ? 0.78 : 0.52,
    })),
    ...[...personLayoutByMemberKey.entries()].map(([memberKey, layout]) => {
      const member = memberByKey.get(memberKey);
      return {
        objectId: orgPersonId(memberKey),
        sourceType: "MEMBER_RECORD",
        sourceId: memberMappings[memberKey]?.memberId ?? memberKey,
        quote: `${member?.name ?? memberKey} is assigned to ${layout.roleTitles.slice(0, 3).join(", ")}.`,
        relevanceScore: 0.76,
      };
    }),
  ];

  const agentEvidenceSpecs = [
    {
      objectId: agentObjectId("input-meeting-transcript"),
      sourceType: "MEETING",
      sourceId: aiMeeting?.id ?? "innovation-ai-working-group",
      quote: "Discussed AI governance, drug discovery ML platforms, and digital twin pilots.",
      relevanceScore: 0.86,
    },
    {
      objectId: agentObjectId("input-brain-articles"),
      sourceType: "BRAIN_ARTICLE",
      sourceId: "capital-allocation-framework",
      quote: "Capital allocation and governance records can support agent suggestions, but approval is still required.",
      relevanceScore: 0.8,
    },
    {
      objectId: agentObjectId("input-audit-trail"),
      sourceType: "AGENT_RUN",
      sourceId: `${wsId}-showcase-run-meeting-summary-3`,
      quote: "Meeting Summary Agent completed a traceable extraction run with tool calls and model usage.",
      relevanceScore: 0.78,
    },
    {
      objectId: agentObjectId("region-context-agent"),
      sourceType: "AGENT_IDENTITY",
      sourceId: `${wsId}-agent-daily-digest`,
      quote: "The agent reads only the selected map area and returns evidence, questions, and next actions.",
      relevanceScore: 0.82,
    },
    {
      objectId: agentObjectId("diff-proposal-agent"),
      sourceType: "AGENT_IDENTITY",
      sourceId: `${wsId}-agent-meeting-summary`,
      quote: "Agent outputs can suggest map changes, but approved company context remains controlled by review.",
      relevanceScore: 0.84,
    },
    {
      objectId: agentObjectId("policy-scoped-read"),
      sourceType: "POLICY_RECORD",
      sourceId: "context-graph-scoped-read",
      quote: "Agents may read selected map context only when workspace membership and permissions allow it.",
      relevanceScore: 0.9,
    },
    {
      objectId: agentObjectId("policy-propose-only"),
      sourceType: "POLICY_RECORD",
      sourceId: "context-graph-propose-only",
      quote: "Agent outputs that change approved context must go through before/after review.",
      relevanceScore: 0.92,
    },
    {
      objectId: agentObjectId("policy-human-approval"),
      sourceType: "POLICY_RECORD",
      sourceId: "context-graph-human-approval",
      quote: "Admins and facilitators approve, edit, or reject proposed map changes.",
      relevanceScore: 0.9,
    },
    {
      objectId: agentObjectId("tool-context-read"),
      sourceType: "MCP_TOOL",
      sourceId: "context-graph.read",
      quote: "The read path returns selected map context and does not change approved records.",
      relevanceScore: 0.86,
    },
    {
      objectId: agentObjectId("tool-proposed-diff"),
      sourceType: "MCP_TOOL",
      sourceId: "context-graph.propose",
      quote: "The propose path saves pending changes for review.",
      relevanceScore: 0.88,
    },
    {
      objectId: agentObjectId("output-region-context"),
      sourceType: "CONTEXT_PACKET",
      sourceId: `${wsId}-agent-region-context-packet`,
      quote: "Selected map context includes the relevant background, evidence, open questions, and likely next actions.",
      relevanceScore: 0.86,
    },
    {
      objectId: agentObjectId("output-proposed-diff"),
      sourceType: "PROPOSED_DIFF",
      sourceId: `${wsId}-ctx-agent-demo-diff`,
      quote: "Proposed changes stay pending until an authorized human approves, edits, or rejects them.",
      relevanceScore: 0.88,
    },
    {
      objectId: agentObjectId("output-audit-event"),
      sourceType: "AUDIT_TRAIL",
      sourceId: "context-graph.proposed-diff.created",
      quote: "Audit events preserve who proposed the change and what review outcome followed.",
      relevanceScore: 0.82,
    },
    {
      objectId: agentObjectId("risk-silent-mutation"),
      sourceType: "RISK_REGISTER",
      sourceId: "silent-graph-mutation",
      quote: "Silent map updates are controlled by suggestion-only tools, approval policy, evidence display, and audit trails.",
      relevanceScore: 0.86,
    },
  ];

  const evidenceSpecs = [...processEvidenceSpecs, ...orgEvidenceSpecs, ...agentEvidenceSpecs];

  for (const evidence of evidenceSpecs) {
    const sourceType = evidence.sourceType ?? "MEETING";
    const sourceId = evidence.sourceId ?? aiMeeting?.id ?? "innovation-ai-working-group";
    const existing = await prisma.contextGraphEvidenceRef.findFirst({
      where: {
        workspaceId: wsId,
        objectId: evidence.objectId,
        sourceType,
        sourceId,
      },
    });
    const data = {
      workspaceId: wsId,
      objectId: evidence.objectId,
      sourceType,
      sourceId,
      quote: evidence.quote,
      relevanceScore: evidence.relevanceScore,
      metadata: { demo: true, viewType: sourceType === "MEETING" ? "process" : "org" },
    };
    if (existing) {
      await prisma.contextGraphEvidenceRef.update({ where: { id: existing.id }, data });
    } else {
      await prisma.contextGraphEvidenceRef.create({ data });
    }
  }
}

async function refreshAdviceDeliberationEntries(proposal, records) {
  const prefix = `${proposal.id}-seed-advice-`;
  const rows = records.map((record, index) => ({
    id: `${prefix}${index + 1}`,
    workspaceId: proposal.workspaceId,
    parentType: "PROPOSAL",
    parentId: proposal.id,
    parentVersion: proposal.version,
    ...record,
  }));

  await prisma.deliberationEntry.deleteMany({
    where: {
      workspaceId: proposal.workspaceId,
      parentType: "PROPOSAL",
      parentId: proposal.id,
      id: {
        startsWith: prefix,
        notIn: rows.map((row) => row.id),
      },
    },
  });

  for (const row of rows) {
    const { id, ...data } = row;
    await prisma.deliberationEntry.upsert({
      where: { id },
      update: data,
      create: row,
    });
  }
}

async function main() {
  console.log("Starting J&J Demo Workspace Seed...");

  // 1. Create Workspace
  const workspace = await prisma.workspace.upsert({
    where: { slug: WORKSPACE_SLUG },
    update: { name: WORKSPACE_NAME, description: WORKSPACE_DESC },
    create: { slug: WORKSPACE_SLUG, name: WORKSPACE_NAME, description: WORKSPACE_DESC }
  });
  const wsId = workspace.id;
  console.log(`✅ Workspace created: ${WORKSPACE_NAME}`);

  // 2. Create Users & Members
  const memberMappings = {};
  for (const tm of TEAM_MEMBERS) {
    const user = await prisma.user.upsert({
      where: { email: tm.email },
      update: {
        displayName: tm.name,
        bio: tm.bio,
        linkedinUrl: tm.linkedinUrl || DEMO_LINKEDIN_URL,
        websiteUrl: tm.websiteUrl || DEMO_WEBSITE_URL,
        passwordHash: hashPassword(tm.password || "jnj12345"),
      },
      create: {
        email: tm.email,
        displayName: tm.name,
        bio: tm.bio,
        linkedinUrl: tm.linkedinUrl || DEMO_LINKEDIN_URL,
        websiteUrl: tm.websiteUrl || DEMO_WEBSITE_URL,
        passwordHash: hashPassword(tm.password || "jnj12345"),
      }
    });
    
    const member = await prisma.member.upsert({
      where: { workspaceId_userId: { workspaceId: wsId, userId: user.id } },
      update: { role: tm.role, isActive: true },
      create: { workspaceId: wsId, userId: user.id, role: tm.role, isActive: true }
    });
    
    const key = tm.email.split("@")[0];
    memberMappings[key] = { userId: user.id, memberId: member.id };
  }
  console.log(`✅ ${TEAM_MEMBERS.length} Users/Members created`);

  // 3. Create Constitution
  await prisma.constitution.upsert({
    where: { workspaceId_version: { workspaceId: wsId, version: 1 } },
    update: { bodyMd: CONSTITUTION },
    create: {
      workspaceId: wsId,
      version: 1,
      bodyMd: CONSTITUTION,
      diffSummary: "Initial constitution adapted from Our Credo",
      modelUsed: "manual-seed",
      triggerType: "MANUAL",
      triggerRef: "seed"
    }
  });

  // 4. Create Circles & Roles
  const circleMappings = {};
  for (const c of CIRCLES) {
    const circle = await prisma.circle.upsert({
      where: { id: `${wsId}-${c.id}` },
      update: { name: c.name, purposeMd: c.purpose },
      create: { id: `${wsId}-${c.id}`, workspaceId: wsId, name: c.name, purposeMd: c.purpose }
    });
    circleMappings[c.id] = circle.id;
  }
  
  for (const r of ROLES) {
    const circleId = circleMappings[r.circle];
    const roleId = `${circleId}-role-${slugify(r.name)}`;
    const role = await prisma.role.upsert({
      where: { id: roleId },
      update: { name: r.name, purposeMd: r.purpose, accountabilities: r.accountabilities },
      create: { id: roleId, circleId: circleId, name: r.name, purposeMd: r.purpose, accountabilities: r.accountabilities }
    });
    
    if (r.assignee && memberMappings[r.assignee]) {
      const memberId = memberMappings[r.assignee].memberId;
      await prisma.roleAssignment.upsert({
        where: { roleId_memberId: { roleId: role.id, memberId } },
        update: {},
        create: { roleId: role.id, memberId }
      });
    }
  }
  console.log(`✅ ${CIRCLES.length} Circles and ${ROLES.length} Roles created`);

  // 5. Create Brain Articles
  for (const a of ARTICLES) {
    const slug = slugify(a.title);
    const created = await prisma.brainArticle.upsert({
      where: { workspaceId_slug: { workspaceId: wsId, slug } },
      update: { title: a.title, type: a.type, authority: a.authority, bodyMd: a.body, publishedAt: nDaysAgo(5) },
      create: { workspaceId: wsId, slug, title: a.title, type: a.type, authority: a.authority, bodyMd: a.body, publishedAt: nDaysAgo(5) }
    });
    
    const versionId = `${created.id}-version-1`;
    const existingVersion = await prisma.brainArticleVersion.findFirst({
      where: { articleId: created.id, version: 1 },
    });
    const versionData = { articleId: created.id, version: 1, bodyMd: a.body, changeSummary: "Initial seed" };
    if (existingVersion) {
      await prisma.brainArticleVersion.update({ where: { id: existingVersion.id }, data: versionData });
    } else {
      await prisma.brainArticleVersion.upsert({
        where: { id: versionId },
        update: versionData,
        create: { id: versionId, ...versionData },
      });
    }
  }
  console.log(`✅ ${ARTICLES.length} Brain Articles created`);

  // 6. Create Meetings
  const meetingMappings = {};
  for (const m of MEETINGS) {
    const participantIds = (m.participants ?? [])
      .map((key) => memberMappings[key]?.userId)
      .filter(Boolean);
    const meeting = await prisma.meeting.upsert({
      where: { externalId: `${wsId}-meet-${slugify(m.title)}` },
      update: { transcript: m.transcript, summaryMd: m.summary, participantIds, aiProcessedAt: nDaysAgo(0) },
      create: {
        workspaceId: wsId,
        title: m.title,
        source: "seed-jnj",
        externalId: `${wsId}-meet-${slugify(m.title)}`,
        recordedAt: new Date(m.recordedAt),
        participantIds,
        transcript: m.transcript,
        summaryMd: m.summary,
        aiProcessedAt: nDaysAgo(0)
      }
    });
    meetingMappings[m.title] = meeting;
  }
  console.log(`✅ ${MEETINGS.length} Meetings created`);

  const processingDemoMeeting = meetingMappings["Innovation & AI Working Group Kickoff"];
  if (processingDemoMeeting) {
    const completedAt = nDaysAgo(0);
    const stageStatuses = completedMeetingProcessingStageStatuses(completedAt);
    await prisma.meetingTranscriptProcessingProgress.upsert({
      where: { meetingId: processingDemoMeeting.id },
      update: {
        workspaceId: wsId,
        currentStage: "READY",
        stageStatuses,
        currentWorkflowJobId: `${processingDemoMeeting.id}-processing-ready`,
        currentWorkflowJobType: "knowledge.sync.meeting",
        currentWorkflowJobStatus: "COMPLETED",
        attemptCount: 1,
        safeErrorCode: null,
        safeErrorMessage: null,
        startedAt: completedAt,
        completedAt,
        failedAt: null,
      },
      create: {
        workspaceId: wsId,
        meetingId: processingDemoMeeting.id,
        currentStage: "READY",
        stageStatuses,
        currentWorkflowJobId: `${processingDemoMeeting.id}-processing-ready`,
        currentWorkflowJobType: "knowledge.sync.meeting",
        currentWorkflowJobStatus: "COMPLETED",
        attemptCount: 1,
        safeErrorCode: null,
        safeErrorMessage: null,
        startedAt: completedAt,
        completedAt,
        failedAt: null,
      },
    });

    for (const [index, type] of [
      "agent.meeting-summary",
      "meeting.insights.extract",
      "agent.action-extraction",
      "meeting.summary.post",
      "knowledge.sync.meeting",
    ].entries()) {
      await prisma.workflowJob.upsert({
        where: { dedupeKey: `${processingDemoMeeting.id}:${type}:seed-jnj-demo` },
        update: {
          workspaceId: wsId,
          type,
          payload: { meetingId: processingDemoMeeting.id, source: "seed-jnj-demo" },
          status: "COMPLETED",
          attempts: 1,
          lockedAt: null,
          lockedBy: null,
          startedAt: completedAt,
          completedAt,
          error: null,
        },
        create: {
          id: `${processingDemoMeeting.id}-processing-job-${index + 1}`,
          workspaceId: wsId,
          type,
          payload: { meetingId: processingDemoMeeting.id, source: "seed-jnj-demo" },
          status: "COMPLETED",
          dedupeKey: `${processingDemoMeeting.id}:${type}:seed-jnj-demo`,
          attempts: 1,
          startedAt: completedAt,
          completedAt,
          error: null,
        },
      });
    }
  }

  const adminUserId = memberMappings["jduato"].userId;
  for (const insight of MEETING_INSIGHTS) {
    const meeting = meetingMappings[insight.meetingTitle];
    if (!meeting) continue;
    const insightId = `${meeting.id}-${insight.idSuffix}`;
    await prisma.meetingInsight.upsert({
      where: { id: insightId },
      update: {
        type: insight.type,
        operation: "CREATE",
        status: insight.status,
        title: insight.title,
        bodyMd: insight.bodyMd,
        assigneeHint: insight.assigneeHint,
        confidence: insight.confidence,
        sourceQuote: insight.sourceQuote,
        appliedEntityType: insight.appliedEntityType ?? null,
        appliedEntityId: null,
        autoAppliedAt: insight.autoAppliedAt ?? null,
        autoApplyError: null,
        reviewedByUserId: adminUserId,
        reviewedAt: nDaysAgo(0),
      },
      create: {
        id: insightId,
        workspaceId: wsId,
        meetingId: meeting.id,
        type: insight.type,
        operation: "CREATE",
        status: insight.status,
        title: insight.title,
        bodyMd: insight.bodyMd,
        assigneeHint: insight.assigneeHint,
        confidence: insight.confidence,
        sourceQuote: insight.sourceQuote,
        appliedEntityType: insight.appliedEntityType ?? null,
        appliedEntityId: null,
        autoAppliedAt: insight.autoAppliedAt ?? null,
        autoApplyError: null,
        reviewedByUserId: adminUserId,
        reviewedAt: nDaysAgo(0),
      }
    });
  }
  console.log(`✅ ${MEETING_INSIGHTS.length} Meeting insights created`);

  // 7. Create Tensions
  for (const [index, t] of TENSIONS.entries()) {
    const assignee = t.assignee && memberMappings[t.assignee] ? memberMappings[t.assignee].memberId : null;
    const tensionId = `${wsId}-tension-${slugify(t.title)}`;
    const exists = await prisma.tension.findFirst({
      where: { workspaceId: wsId, title: t.title },
      orderBy: { createdAt: "asc" },
    });
    const data = {
      workspaceId: wsId,
      authorUserId: adminUserId,
      assigneeMemberId: assignee,
      title: t.title,
      bodyMd: t.body,
      status: t.status,
      priority: t.priority ?? Math.max(0, TENSIONS.length - index),
      isPrivate: false,
      publishedAt: t.publishedAt ?? nDaysAgo(2),
      resolvedAt: t.resolvedAt ?? (t.status === "RESOLVED" ? nDaysAgo(1) : null),
      resolvedVia: t.resolvedVia ?? null,
      archivedAt: null,
      archivedByUserId: null,
      archiveReason: null,
    };
    if (exists) {
      await prisma.tension.update({ where: { id: exists.id }, data });
    } else {
      await prisma.tension.upsert({
        where: { id: tensionId },
        update: data,
        create: { id: tensionId, ...data },
      });
    }
  }

  // 8. Create Actions
  for (const [index, a] of ACTIONS.entries()) {
    const assignee = a.assignee && memberMappings[a.assignee] ? memberMappings[a.assignee].memberId : null;
    const actionId = `${wsId}-action-${slugify(a.title)}`;
    const exists = await prisma.action.findFirst({
      where: { workspaceId: wsId, title: a.title },
      orderBy: { createdAt: "asc" },
    });
    const data = {
      workspaceId: wsId,
      authorUserId: adminUserId,
      assigneeMemberId: assignee,
      title: a.title,
      status: a.status,
      priority: a.priority ?? Math.max(0, ACTIONS.length - index),
      dueAt: Number.isFinite(a.dueInDays) ? nDaysFromNow(a.dueInDays) : null,
      isPrivate: false,
      publishedAt: nDaysAgo(1),
      archivedAt: null,
      archivedByUserId: null,
      archiveReason: null,
    };
    const action = exists
      ? await prisma.action.update({ where: { id: exists.id }, data })
      : await prisma.action.upsert({
        where: { id: actionId },
        update: data,
        create: { id: actionId, ...data },
      });
    if (a.checklist?.length) {
      await prisma.actionChecklistItem.deleteMany({
        where: {
          workspaceId: wsId,
          actionId: action.id,
          id: { startsWith: `${action.id}-checklist-` },
        },
      });
      for (const [itemIndex, item] of a.checklist.entries()) {
        const checklistId = `${action.id}-checklist-${itemIndex + 1}`;
        const completedAt = item.completed ? nDaysAgo(Math.max(0, itemIndex)) : null;
        await prisma.actionChecklistItem.upsert({
          where: { id: checklistId },
          update: {
            workspaceId: wsId,
            actionId: action.id,
            title: item.title,
            sortOrder: itemIndex,
            completedAt,
            completedByUserId: completedAt ? adminUserId : null,
          },
          create: {
            id: checklistId,
            workspaceId: wsId,
            actionId: action.id,
            title: item.title,
            sortOrder: itemIndex,
            completedAt,
            completedByUserId: completedAt ? adminUserId : null,
          },
        });
      }
    }
  }
  
  // 9. proposals
  const createdProposals = {};
  for (const [index, p] of PROPOSALS.entries()) {
    const authorId = memberMappings[p.author].userId;
    const circleId = circleMappings[p.circle];
    const proposalId = `${wsId}-proposal-${slugify(p.title)}`;
    const data = {
      workspaceId: wsId,
      authorUserId: authorId,
      circleId: circleId,
      title: p.title,
      summary: p.summary,
      bodyMd: p.body,
      status: p.status,
      priority: p.priority ?? Math.max(0, PROPOSALS.length - index),
      resolutionOutcome: p.resolutionOutcome ?? null,
      isPrivate: false,
      publishedAt: p.publishedAt,
      decidedAt: p.status === "RESOLVED" ? p.publishedAt : null,
      archivedAt: p.archivedAt ?? null,
      archivedByUserId: null,
      archiveReason: null
    };
    const proposal = await prisma.proposal.upsert({
      where: { id: proposalId },
      update: data,
      create: { id: proposalId, ...data },
    });
    await prisma.proposal.deleteMany({
      where: {
        workspaceId: wsId,
        id: { not: proposal.id },
        authorUserId: authorId,
        circleId,
        title: p.title,
        summary: p.summary,
        bodyMd: p.body,
      },
    });
    const potentialReactors = Object.values(memberMappings).filter((member) => member.userId !== authorId);
    const reactionRows = potentialReactors.slice(0, Math.min(potentialReactors.length, (index % 3) + 1)).map((reactor, reactorIndex) => ({
      id: `${proposal.id}-seed-reaction-${reactorIndex + 1}`,
      workspaceId: wsId,
      parentType: "PROPOSAL",
      parentId: proposal.id,
      parentVersion: proposal.version,
      authorUserId: reactor.userId,
      entryType: "REACTION",
      bodyMd: "Seeded demo reaction for proposal deliberation.",
    }));
    await prisma.deliberationEntry.deleteMany({
      where: {
        parentType: "PROPOSAL",
        parentId: proposal.id,
        id: {
          startsWith: `${proposal.id}-seed-reaction-`,
        },
      },
    });
    for (const reaction of reactionRows) {
      const { id, ...reactionData } = reaction;
      await prisma.deliberationEntry.upsert({
        where: { id },
        update: reactionData,
        create: reaction,
      });
    }
    createdProposals[p.title] = proposal;
  }
  
  // 10. Advice Process
  const apTitle1 = "Mandate Tier-1 Supplier ESG Reporting";
  const apProp1 = createdProposals[apTitle1];
  if (apProp1 && apProp1.status === "OPEN") {
    const data = {
      workspaceId: wsId,
      proposalId: apProp1.id,
      authorMemberId: memberMappings["vbroadhurst"].memberId,
      ownerMemberId: memberMappings["vbroadhurst"].memberId,
      subjectType: "PROPOSAL",
      subjectId: apProp1.id,
      status: "GATHERING"
    };
    await prisma.adviceProcess.upsert({
      where: { proposalId: apProp1.id },
      update: data,
      create: data,
    });
    await refreshAdviceDeliberationEntries(apProp1, [
      { authorUserId: memberMappings["jwolk"].userId, entryType: "REACTION", bodyMd: "Supply chain costs will increase slightly in the short term, but long term risk mitigation is sound. Approved from a finance perspective." },
      { authorUserId: memberMappings["jtaubert"].userId, entryType: "REACTION", bodyMd: "Agreed. Needed for our IM facilities." },
      { authorUserId: memberMappings["mullmann"].userId, entryType: "OBJECTION", bodyMd: "We need 6-month grace periods for critical sole-source suppliers before enforcement." }
    ]);
  }

  const apTitle2 = "Global Clinical Trial Data Sharing Framework";
  const apProp2 = createdProposals[apTitle2];
  if (apProp2 && apProp2.status === "OPEN") {
    const data = {
      workspaceId: wsId,
      proposalId: apProp2.id,
      authorMemberId: memberMappings["jreed"].memberId,
      ownerMemberId: memberMappings["jreed"].memberId,
      subjectType: "PROPOSAL",
      subjectId: apProp2.id,
      status: "GATHERING"
    };
    await prisma.adviceProcess.upsert({
      where: { proposalId: apProp2.id },
      update: data,
      create: data,
    });
    await refreshAdviceDeliberationEntries(apProp2, [
      { authorUserId: memberMappings["jtaubert"].userId, entryType: "REACTION", bodyMd: "Fully support this framework." },
      { authorUserId: memberMappings["mullmann"].userId, entryType: "OBJECTION", bodyMd: "Ensure IP clauses explicitly protect our pending patents." }
    ]);
  }
  
  // 11. Governance Scores
  const governanceScoreIds = SCORES.map((_, index) => `${wsId}-governance-score-${index + 1}`);
  await prisma.governanceScore.deleteMany({
    where: {
      workspaceId: wsId,
      id: {
        startsWith: `${wsId}-governance-score-`,
        notIn: governanceScoreIds,
      },
    },
  });
  for (const [index, s] of SCORES.entries()) {
    const scoreId = governanceScoreIds[index];
    const data = {
      workspaceId: wsId,
      periodStart: new Date(s.periodEnd.getTime() - 90 * 24 * 60 * 60 * 1000),
      periodEnd: s.periodEnd,
      overallScore: s.score,
      ...s.parts
    };
    await prisma.governanceScore.upsert({
      where: { id: scoreId },
      update: data,
      create: { id: scoreId, ...data },
    });
  }
  
  const practiceProjectIds = PRACTICE_PROJECTS.map((project) => `${wsId}-practice-project-${slugify(project.code)}`);
  const practiceProjectIdByCode = new Map(PRACTICE_PROJECTS.map((project, index) => [project.code, practiceProjectIds[index]]));
  await prisma.practiceProject.deleteMany({
    where: {
      workspaceId: wsId,
      id: {
        startsWith: `${wsId}-practice-project-`,
        notIn: practiceProjectIds,
      },
    },
  });
  for (const [index, project] of PRACTICE_PROJECTS.entries()) {
    const projectId = practiceProjectIds[index];
    const data = {
      workspaceId: wsId,
      code: project.code,
      name: project.name,
      clientName: project.clientName,
      status: project.status,
      poValueCents: project.poValueCents,
      serviceBudgetCents: project.serviceBudgetCents,
      expenseBudgetCents: project.expenseBudgetCents,
      usedCents: project.usedCents,
      weeklyBurnCents: project.weeklyBurnCents,
      targetMarginBps: project.targetMarginBps,
      currentMarginBps: project.currentMarginBps,
      sourceSatelliteId: project.sourceSatelliteId,
    };
    await prisma.practiceProject.upsert({
      where: { id: projectId },
      update: data,
      create: { id: projectId, ...data },
    });
  }
  const practiceContributionIds = PRACTICE_CONTRIBUTIONS.map((_, index) => `${wsId}-practice-contribution-${index + 1}`);
  await prisma.practiceContributionEntry.deleteMany({
    where: {
      workspaceId: wsId,
      id: {
        startsWith: `${wsId}-practice-contribution-`,
        notIn: practiceContributionIds,
      },
    },
  });
  for (const [index, contribution] of PRACTICE_CONTRIBUTIONS.entries()) {
    const projectId = practiceProjectIdByCode.get(contribution.projectCode);
    const contributor = memberMappings[contribution.memberKey];
    if (!projectId || !contributor) continue;
    const amountCents = contribution.type === "TIME"
      ? Math.round((contribution.hoursTenths * contribution.rateCents) / 10)
      : contribution.amountCents;
    const sliceMultiplier = contribution.paymentChoice === "SLICING_PIE"
      ? (contribution.type === "TIME" ? 2 : 4)
      : 0;
    const data = {
      workspaceId: wsId,
      projectId,
      contributorUserId: contributor.userId,
      type: contribution.type,
      paymentChoice: contribution.paymentChoice,
      cashStatus: contribution.paymentChoice === "CASH" ? (contribution.paid ? "PAID" : "REQUESTED") : "NOT_APPLICABLE",
      description: contribution.description,
      occurredAt: contribution.occurredAt,
      hoursTenths: contribution.type === "TIME" ? contribution.hoursTenths : null,
      rateCents: contribution.type === "TIME" ? contribution.rateCents : null,
      amountCents,
      currency: contribution.currency ?? "USD",
      receiptUrl: null,
      sliceMultiplier,
      slices: amountCents * sliceMultiplier,
      paidAt: contribution.paymentChoice === "CASH" && contribution.paid ? nDaysAgoAtNoonUtc(4) : null,
      paidByUserId: contribution.paymentChoice === "CASH" && contribution.paid ? memberMappings["jwolk"]?.userId ?? null : null,
    };
    await prisma.practiceContributionEntry.upsert({
      where: { id: practiceContributionIds[index] },
      update: data,
      create: { id: practiceContributionIds[index], ...data },
    });
  }

  // 13. Policy Corpus
  const policies = [
    { title: "APAC Market Expansion Authorization", pTitle: "Expand DARZALEX Subcutaneous Roll-out to APAC Markets", cId: circleMappings["innovative-medicine"] },
    { title: "Capital Allocation Review Framework", pTitle: "Q1 2025 Capital Allocation Amendment", cId: circleMappings["finance"] },
    { title: "CARVYKTI Manufacturing Investment Authorization", pTitle: "CARVYKTI Manufacturing Capacity Expansion", cId: circleMappings["innovative-medicine"] },
    { title: "Supplier Diversity Spending Targets FY2026", pTitle: "Supplier Diversity Spending Target for FY2026", cId: circleMappings["esg"] }
  ];
  for (const pol of policies) {
    const prop = createdProposals[pol.pTitle];
    if (prop && prop.status === "RESOLVED" && prop.resolutionOutcome === "ADOPTED") {
      const data = {
        workspaceId: wsId,
        proposalId: prop.id,
        title: pol.title,
        bodyMd: prop.bodyMd,
        circleId: pol.cId,
        acceptedAt: prop.publishedAt
      };
      await prisma.policyCorpus.upsert({
        where: { proposalId: prop.id },
        update: data,
        create: data,
      });
    }
  }

  // 14. Safe showcase data for current customer-visible feature surfaces.
  await enableWorkspaceFeature(wsId, "AI_WORKSPACES");
  await enableWorkspaceFeature(wsId, "FINANCE");
  await enableWorkspaceFeature(wsId, "SLICING_PIE");
  await enableWorkspaceFeature(wsId, "PRACTICE_PROJECTS");
  await enableWorkspaceFeature(wsId, "RELATIONSHIPS");
  await seedShowcaseData({ wsId, memberMappings });
  await seedCrmRelationships(wsId, memberMappings);
  await seedContextMapData({ wsId, circleMappings, memberMappings, meetingMappings });

  const counts = {
    articles: await prisma.brainArticle.count({ where: { workspaceId: wsId } }),
    actions: await prisma.action.count({ where: { workspaceId: wsId } }),
    tensions: await prisma.tension.count({ where: { workspaceId: wsId } }),
    proposals: await prisma.proposal.count({ where: { workspaceId: wsId } }),
    goals: await prisma.goal.count({ where: { workspaceId: wsId } }),
    meetings: await prisma.meeting.count({ where: { workspaceId: wsId } }),
    circles: await prisma.circle.count({ where: { workspaceId: wsId } }),
    agentRuns: await prisma.agentRun.count({ where: { workspaceId: wsId } }),
    agentIdentities: await prisma.agentIdentity.count({ where: { workspaceId: wsId } }),
    recognitions: await prisma.recognition.count({ where: { workspaceId: wsId } }),
    auditLogs: await prisma.auditLog.count({ where: { workspaceId: wsId } }),
    contextObjects: await prisma.contextGraphObject.count({ where: { workspaceId: wsId } }),
    contextMaps: await prisma.contextMapView.count({ where: { workspaceId: wsId } }),
    crmAccounts: await prisma.crmAccount.count({ where: { workspaceId: wsId, archivedAt: null } }),
    crmContacts: await prisma.crmContact.count({ where: { workspaceId: wsId, archivedAt: null } }),
    crmDeals: await prisma.crmDeal.count({ where: { workspaceId: wsId, archivedAt: null } }),
    practiceProjects: await prisma.practiceProject.count({ where: { workspaceId: wsId } }),
    practiceContributions: await prisma.practiceContributionEntry.count({ where: { workspaceId: wsId } }),
  };

  console.log("Demo workspace refreshed:");
  Object.entries(counts).forEach(([key, value]) => {
    console.log(`  ${key.padEnd(18)} ${value}`);
  });

  console.log("✅ Seed complete! You can log in with: demo@jnj-demo.corgtex.app / demo1234");
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
