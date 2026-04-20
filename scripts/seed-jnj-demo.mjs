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

// Data Definition
const TEAM_MEMBERS = [
  { email: "demo@jnj-demo.corgtex.app", name: "Demo User", role: "ADMIN", password: "demo1234", title: "Observer" },
  { email: "jduato@jnj.demo.corgtex.app", name: "Joaquin Duato", role: "ADMIN", title: "Chairman & CEO" },
  { email: "jwolk@jnj.demo.corgtex.app", name: "Joseph J. Wolk", role: "FINANCE_STEWARD", title: "EVP, CFO" },
  { email: "jtaubert@jnj.demo.corgtex.app", name: "Jennifer L. Taubert", role: "FACILITATOR", title: "Worldwide Chairman, Innovative Medicine" },
  { email: "tschmid@jnj.demo.corgtex.app", name: "Timothy Schmid", role: "FACILITATOR", title: "Worldwide Chairman, MedTech" },
  { email: "jreed@jnj.demo.corgtex.app", name: "John C. Reed", role: "CONTRIBUTOR", title: "EVP, R&D" },
  { email: "vbroadhurst@jnj.demo.corgtex.app", name: "Vanessa Broadhurst", role: "CONTRIBUTOR", title: "EVP, Global Corporate Affairs" },
  { email: "mullmann@jnj.demo.corgtex.app", name: "Michael Ullmann", role: "CONTRIBUTOR", title: "EVP, General Counsel" },
  { email: "pfasolo@jnj.demo.corgtex.app", name: "Peter Fasolo", role: "CONTRIBUTOR", title: "EVP, CHRO" },
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
    transcript: "J. Duato: Let's review the Q4 numbers. We closed the year strong at $88.8 billion in revenue. Innovative Medicine delivered almost $57 billion, and MedTech contributed $31.9 billion. J. Wolk: Yes, operational growth was solid. DARZALEX and TREMFYA were the main drivers in IM. In MedTech, electrophysiology is outperforming. We do see some margin pressure from supply chain, but overall EPS is in line. J. Taubert: Looking at STELARA, we need to prepare for biosimilar impacts next year. I propose we increase the localized commercial push for TREMFYA. T. Schmid: For MedTech, Abiomed integration is going smoothly, but we need to accelerate international rollout to justify the ROI. Let's allocate more budget to the EU team.",
    summary: "Reviewed Q4 2024 performance showing $88.8B total revenue. Innovative Medicine ($57B) driven by DARZALEX and TREMFYA. MedTech ($31.9B) led by electrophysiology and Abiomed. Discussed margin pressures, upcoming STELARA biosimilar competition, and accelerating Abiomed's international rollout."
  },
  { title: "Executive Committee Strategic Planning", recordedAt: "2024-11-20T14:00:00Z",
    transcript: "J. Duato: Welcome everyone. Today we align on our 2025 capital allocation. Following the Kenvue separation, our focus must be strictly on high-growth pharma and MedTech. J. Reed: The pipeline is robust, but I need an additional $500M in the oncology R&D budget to accelerate the CARVYKTI scale-up and new indications. J. Wolk: The capital framework supports R&D first, but we are also targeting specific MedTech tuck-in acquisitions. P. Fasolo: Culturally, our Credo survey shows employees want more clarity on the future of our decentralized model. We must communicate that agility remains our priority.",
    summary: "Aligned on 2025 strategy post-Kenvue. Confirmed focus on high-growth Innovative Medicine and MedTech. Requested $500M R&D boost for CARVYKTI oncology scale-up. Reaffirmed commitment to the decentralized operating model and Our Credo."
  },
  { title: "ESG & Regulatory Compliance Update", recordedAt: "2024-10-10T09:00:00Z",
    transcript: "M. Ullmann: As part of the RCSC oversight, we need to finalize our Health for Humanity reporting for the year. V. Broadhurst: We are on track for our science-based climate targets, specifically renewable electricity. However, we have a tension regarding supplier emissions (Scope 3). It's difficult to track. I propose we mandate ESG reporting from our top 50 global suppliers next year. J. Wolk: Agreed, but we must provide them with the monitoring tools or we risk supply chain disruption. Let's form an action group.",
    summary: "Reviewed Health for Humanity progress. On track for internal climate targets but facing challenges with Scope 3 supplier emissions tracking. Proposed to mandate ESG reporting for top 50 suppliers, with a plan to assist them via monitoring tools to prevent supply chain disruption."
  },
  { title: "Board of Directors Quarterly Review", recordedAt: "2024-12-18T10:00:00Z",
    transcript: "P. Fasolo: Presenting the talent retention numbers in key R&D hubs... retention remains strong. J. Wolk: Debt issuance strategy for early 2025 is structured to maintain our AAA rating.",
    summary: "Reviewed board governance, committee reports, and FY2025 financial outlook."
  },
  { title: "MedTech Product Strategy Deep Dive", recordedAt: "2024-09-15T09:00:00Z",
    transcript: "T. Schmid: The Monarch platform is showing robust adoption curves, but Velys needs more localized training centers in EMEA.",
    summary: "Deep dive into robotic surgery roadmap, Abiomed international expansion, and Vision Care."
  },
  { title: "Innovation & AI Working Group Kickoff", recordedAt: "2025-01-28T14:00:00Z",
    transcript: "J. Reed: Generative AI will change target optimization. We are establishing an internal COE to standardize tooling.",
    summary: "Discussed AI governance, drug discovery ML platforms, and digital twin pilots."
  }
];

const TENSIONS = [
  { title: "STELARA biosimilar erosion risk", status: "IN_PROGRESS", assignee: null,
    body: "With STELARA facing biosimilar competition soon, we need a definitive strategy to transition patients and secure revenue lines via TREMFYA and other immunology assets." },
  { title: "Scope 3 Supplier Emissions Tracking", status: "OPEN", assignee: null,
    body: "We cannot accurately report our full Health for Humanity climate impact without better data from our top 50 tier-1 suppliers." },
  { title: "Oncology R&D Budget Constraints", status: "OPEN", assignee: null,
    body: "CARVYKTI scale-up requires more capital to expand manufacturing capacity and clinical trials for earlier lines of therapy." },
  { title: "Abiomed International Rollout Velocity", status: "IN_PROGRESS", assignee: null,
    body: "European expansion for Abiomed is lagging behind financial models. Need dedicated commercial teams in the DACH region." },
  { title: "AI Integration in Drug Discovery", status: "OPEN", assignee: null,
    body: "Competitors are accelerating lead optimization using generative AI. We lack a unified AI infrastructure across the R&D segment." },
  { title: "Post-Kenvue Brand Identity Transition", status: "OPEN", assignee: "vbroadhurst",
    body: "Need to fully distinguish J&J as an enterprise exclusively focused on healthcare innovation." },
  { title: "MedTech Regulatory Approval Delays in EU", status: "IN_PROGRESS", assignee: "tschmid",
    body: "MDR compliance is creating a bottleneck for our Vision products in specific EU markets." },
  { title: "Clinical Staff Retention in Key R&D Sites", status: "OPEN", assignee: "pfasolo",
    body: "We are seeing 15% attrition in our clinical site management talent, primarily to biotech startups." }
];

const ACTIONS = [
  { title: "Review Top 50 Supplier ESG Reports", status: "OPEN", assignee: "vbroadhurst" },
  { title: "Draft TREMFYA Commercial Continuity Plan", status: "IN_PROGRESS", assignee: "jtaubert" },
  { title: "Finalize EU budget allocation for Abiomed", status: "IN_PROGRESS", assignee: "tschmid" },
  { title: "Approve $500M oncology R&D supplement", status: "COMPLETED", assignee: "jwolk" },
  { title: "Schedule Board Strategic Offsite for Q2", status: "OPEN", assignee: "pfasolo" },
  { title: "File TREMFYA EU Label Extension", status: "IN_PROGRESS", assignee: "jtaubert" },
  { title: "Submit FY2025 ESG Targets to RCSC", status: "OPEN", assignee: "vbroadhurst" },
  { title: "Complete Abiomed DACH Hiring Plan", status: "COMPLETED", assignee: "tschmid" }
];

const PROPOSALS = [
  { 
    title: "Expand DARZALEX Subcutaneous Roll-out to APAC Markets", status: "APPROVED", author: "jtaubert", circle: "innovative-medicine", publishedAt: nDaysAgo(60),
    summary: "Approval to increase marketing spend for the subcutaneous formulation rollout in key APAC regions.",
    body: "We are seeking $12.5M to aggressively launch the DARZALEX FASPRO formula in Japan and South Korea, targeting a 15% share capture in Q1."
  },
  { 
    title: "Establish AI Center of Excellence for Drug Discovery", status: "SUBMITTED", author: "jreed", circle: "rd", publishedAt: nDaysAgo(4),
    summary: "Formation of an internal COE to standardize generative AI tooling.",
    body: "Currently, AI usage is fragmented across R&D. This proposal establishes a $20M fund to build a centralized infrastructure leveraging Azure ML."
  },
  { 
    title: "Mandate Tier-1 Supplier ESG Reporting", status: "ADVICE_GATHERING", author: "vbroadhurst", circle: "esg", publishedAt: nDaysAgo(2),
    summary: "Require our top 50 suppliers to report Scope 1-3 emissions bi-annually via the EcoVadis platform.",
    body: "To hit our Health for Humanity target, we must mandate that all Tier-1 suppliers onboard onto our reporting framework before Q4. We will cover the first-year licensing costs."
  },
  { 
    title: "Q1 2025 Capital Allocation Amendment", status: "APPROVED", author: "jwolk", circle: "finance", publishedAt: nDaysAgo(45),
    summary: "Rebalance capital toward R&D and aggressive debt retirement.",
    body: "This amendment shifts $800M from general corporate purposes directly into the R&D Innovation Grant account."
  },
  { 
    title: "Robotic Surgery Platform: Phase II Scale-Up", status: "SUBMITTED", author: "tschmid", circle: "medtech", publishedAt: nDaysAgo(10),
    summary: "Funding for advanced clinical validation of the Monarch system.",
    body: "Proposing $45M over two years to accelerate multi-center validation for bronchoscopy procedures."
  },
  { 
    title: "Decentralized Talent Mobility Program", status: "DRAFT", author: "pfasolo", circle: "board", publishedAt: nDaysAgo(1),
    summary: "A new HR framework allowing 10% talent rotation between MedTech and IM.",
    body: "We need cross-pollination. This framework will subsidize short-term assignments across segments."
  },
  { 
    title: "CARVYKTI Manufacturing Capacity Expansion", status: "APPROVED", author: "jreed", circle: "innovative-medicine", publishedAt: nDaysAgo(25),
    summary: "Significant investment in cell-therapy manufacturing nodes.",
    body: "Demand outpaces supply. We are requesting an immediate $350M CapEx release to construct two new clean-room facilities."
  },
  { 
    title: "Revise Executive Compensation Structure", status: "ARCHIVED", author: "pfasolo", circle: "board", publishedAt: nDaysAgo(80),
    summary: "Shift LTI weighting toward ESG metrics.",
    body: "Proposal to link 15% of the long-term incentive plan to our Health for Humanity diversity goals."
  },
  { 
    title: "Global Clinical Trial Data Sharing Framework", status: "ADVICE_GATHERING", author: "jreed", circle: "rd", publishedAt: nDaysAgo(8),
    summary: "Standardize how we share anonymized trial data with academic partners.",
    body: "We need a governed process for accelerating academic research through secured data enclaves."
  },
  { 
    title: "MedTech Digital Twin Manufacturing Pilot", status: "SUBMITTED", author: "tschmid", circle: "medtech", publishedAt: nDaysAgo(15),
    summary: "Deploying digital twins in our orthopedics manufacturing line.",
    body: "Propose a pilot with Siemens to reduce waste by 12% via real-time twin simulation."
  },
  { 
    title: "Supplier Diversity Spending Target for FY2026", status: "APPROVED", author: "vbroadhurst", circle: "esg", publishedAt: nDaysAgo(50),
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

const LEDGER_ACCOUNTS = [
  { name: "Operating Fund", type: "TREASURY", currency: "USD", balanceCents: 245000000 },
  { name: "R&D Innovation Grant", type: "GRANT", currency: "USD", balanceCents: 85000000 },
  { name: "ESG Programs", type: "DESIGNATED", currency: "USD", balanceCents: 32000000 },
  { name: "MedTech Capital Expenditure", type: "CAPEX", currency: "USD", balanceCents: 120000000 }
];

const SPENDS = [
  { desc: "Q4 DARZALEX Marketing Campaign – APAC", cat: "Marketing", vendor: "Publicis Health", amountCents: 125000000, status: "PAID" },
  { desc: "Abiomed EU Commercial Team Hiring", cat: "HR/Recruiting", vendor: "Internal", amountCents: 45000000, status: "APPROVED" },
  { desc: "CARVYKTI Manufacturing Scale-up Phase 1", cat: "Manufacturing", vendor: "Lilly Engineering", amountCents: 320000000, status: "SUBMITTED" },
  { desc: "Health for Humanity Annual Report", cat: "PR/Comms", vendor: "Edelman", amountCents: 8500000, status: "PAID" },
  { desc: "AI Infrastructure Pilot – Azure ML", cat: "Technology", vendor: "Microsoft", amountCents: 32000000, status: "SUBMITTED" },
  { desc: "Board Strategic Offsite – Q2 2025", cat: "Travel/Events", vendor: "Four Seasons", amountCents: 4200000, status: "DRAFT" },
  { desc: "Clinical Trial Phase III – TREMFYA", cat: "R&D", vendor: "Covance", amountCents: 180000000, status: "APPROVED" },
  { desc: "Supplier ESG Monitoring Platform", cat: "Technology", vendor: "EcoVadis", amountCents: 17500000, status: "SUBMITTED" },
  { desc: "Robotic Surgery Training Program", cat: "Education", vendor: "Intuitive Surgical", amountCents: 29000000, status: "APPROVED" },
  { desc: "Patent Filing – Novel CAR-T Vector", cat: "Legal", vendor: "Fish & Richardson", amountCents: 6500000, status: "PAID" }
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
      update: { displayName: tm.name, passwordHash: hashPassword(tm.password || "jnj12345") },
      create: { email: tm.email, displayName: tm.name, passwordHash: hashPassword(tm.password || "jnj12345") }
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
    
    await prisma.brainArticleVersion.findFirst({ where: { articleId: created.id, version: 1 } }) ||
    await prisma.brainArticleVersion.create({
      data: { articleId: created.id, version: 1, bodyMd: a.body, changeSummary: "Initial seed" }
    });
  }
  console.log(`✅ ${ARTICLES.length} Brain Articles created`);

  // 6. Create Meetings
  for (const m of MEETINGS) {
    await prisma.meeting.upsert({
      where: { externalId: `${wsId}-meet-${slugify(m.title)}` },
      update: { transcript: m.transcript, summaryMd: m.summary },
      create: {
        workspaceId: wsId,
        title: m.title,
        source: "seed-jnj",
        externalId: `${wsId}-meet-${slugify(m.title)}`,
        recordedAt: new Date(m.recordedAt),
        transcript: m.transcript,
        summaryMd: m.summary
      }
    });
  }
  console.log(`✅ ${MEETINGS.length} Meetings created`);

  // 7. Create Tensions
  const adminUserId = memberMappings["jduato"].userId;
  for (const t of TENSIONS) {
    const assignee = t.assignee && memberMappings[t.assignee] ? memberMappings[t.assignee].memberId : null;
    const exists = await prisma.tension.findFirst({ where: { workspaceId: wsId, title: t.title } });
    if (!exists) {
      await prisma.tension.create({
        data: { workspaceId: wsId, authorUserId: adminUserId, assigneeMemberId: assignee, title: t.title, bodyMd: t.body, status: t.status, publishedAt: nDaysAgo(2) }
      });
    }
  }

  // 8. Create Actions
  for (const a of ACTIONS) {
    const assignee = a.assignee && memberMappings[a.assignee] ? memberMappings[a.assignee].memberId : null;
    const exists = await prisma.action.findFirst({ where: { workspaceId: wsId, title: a.title } });
    if (!exists) {
      await prisma.action.create({
        data: { workspaceId: wsId, authorUserId: adminUserId, assigneeMemberId: assignee, title: a.title, status: a.status, publishedAt: nDaysAgo(1) }
      });
    }
  }
  
  // 9. proposals
  const createdProposals = {};
  for (const p of PROPOSALS) {
    const authorId = memberMappings[p.author].userId;
    const circleId = circleMappings[p.circle];
    let proposal = await prisma.proposal.findFirst({ where: { workspaceId: wsId, title: p.title } });
    if (!proposal) {
      proposal = await prisma.proposal.create({
        data: {
          workspaceId: wsId,
          authorUserId: authorId,
          circleId: circleId,
          title: p.title,
          summary: p.summary,
          bodyMd: p.body,
          status: p.status,
          isPrivate: false,
          publishedAt: p.publishedAt,
          decidedAt: (p.status === 'APPROVED' || p.status === 'REJECTED') ? p.publishedAt : null
        }
      });
      // seed reactions sporadically
      const potentialReactors = Object.values(memberMappings).filter(x => x.userId !== authorId);
      for (let i = 0; i < Math.floor(Math.random() * 3) + 1; i++) {
        const reactor = potentialReactors[i];
        if (reactor) {
          const rType = Math.random() > 0.7 ? "CONCERN" : (Math.random() > 0.5 ? "QUESTION" : "SUPPORT");
          await prisma.proposalReaction.create({
            data: { proposalId: proposal.id, userId: reactor.userId, reaction: rType }
          });
        }
      }
    } else {
      proposal = await prisma.proposal.update({
        where: { id: proposal.id },
        data: { isPrivate: false }
      });
    }
    createdProposals[p.title] = proposal;
  }
  
  // 10. Advice Process
  const apTitle1 = "Mandate Tier-1 Supplier ESG Reporting";
  const apProp1 = createdProposals[apTitle1];
  if (apProp1 && apProp1.status === "ADVICE_GATHERING") {
    let ap = await prisma.adviceProcess.findUnique({ where: { proposalId: apProp1.id } });
    if (!ap) {
      ap = await prisma.adviceProcess.create({
        data: {
          workspaceId: wsId,
          proposalId: apProp1.id,
          authorMemberId: memberMappings["vbroadhurst"].memberId,
          status: "GATHERING",
          advisorySuggestionsJson: {
            advisors: [
              { memberId: memberMappings["jwolk"].memberId, name: "Joseph J. Wolk", reason: "Financial impact of supplier mandates" },
              { memberId: memberMappings["mullmann"].memberId, name: "Michael Ullmann", reason: "Contract and compliance review" }
            ]
          }
        }
      });
      await prisma.adviceRecord.createMany({
        data: [
          { processId: ap.id, memberId: memberMappings["jwolk"].memberId, type: "ENDORSE", bodyMd: "Supply chain costs will increase slightly in the short term, but long term risk mitigation is sound. Approved from a finance perspective." },
          { processId: ap.id, memberId: memberMappings["jtaubert"].memberId, type: "ENDORSE", bodyMd: "Agreed. Needed for our IM facilities." },
          { processId: ap.id, memberId: memberMappings["mullmann"].memberId, type: "CONCERN", bodyMd: "We need 6-month grace periods for critical sole-source suppliers before enforcement." }
        ]
      });
    }
  }

  const apTitle2 = "Global Clinical Trial Data Sharing Framework";
  const apProp2 = createdProposals[apTitle2];
  if (apProp2 && apProp2.status === "ADVICE_GATHERING") {
    let ap = await prisma.adviceProcess.findUnique({ where: { proposalId: apProp2.id } });
    if (!ap) {
      ap = await prisma.adviceProcess.create({
        data: {
          workspaceId: wsId,
          proposalId: apProp2.id,
          authorMemberId: memberMappings["jreed"].memberId,
          status: "GATHERING",
          advisorySuggestionsJson: {
            advisors: [
              { memberId: memberMappings["mullmann"].memberId, name: "Michael Ullmann", reason: "Data privacy & IP risk" }
            ]
          }
        }
      });
      await prisma.adviceRecord.createMany({
        data: [
          { processId: ap.id, memberId: memberMappings["jtaubert"].memberId, type: "ENDORSE", bodyMd: "Fully support this framework." },
          { processId: ap.id, memberId: memberMappings["mullmann"].memberId, type: "CONCERN", bodyMd: "Ensure IP clauses explicitly protect our pending patents." }
        ]
      });
    }
  }
  
  // 11. Governance Scores
  for (const s of SCORES) {
    const exists = await prisma.governanceScore.findFirst({ where: { workspaceId: wsId, overallScore: s.score } });
    if (!exists) {
      await prisma.governanceScore.create({
        data: { 
          workspaceId: wsId, 
          periodStart: new Date(s.periodEnd.getTime() - 90 * 24 * 60 * 60 * 1000), 
          periodEnd: s.periodEnd, 
          overallScore: s.score, 
          ...s.parts 
        }
      });
    }
  }
  
  // 12. Ledger Accounts & Spends
  const accountMappings = {};
  for (const acc of LEDGER_ACCOUNTS) {
    const a = await prisma.ledgerAccount.upsert({
      where: { id: `${wsId}-acc-${slugify(acc.name)}` },
      update: { balanceCents: acc.balanceCents },
      create: { id: `${wsId}-acc-${slugify(acc.name)}`, workspaceId: wsId, name: acc.name, type: acc.type, currency: acc.currency, balanceCents: acc.balanceCents }
    });
    accountMappings[acc.name] = a.id;
  }
  
  for (const sp of SPENDS) {
    const exists = await prisma.spendRequest.findFirst({ where: { workspaceId: wsId, description: sp.desc } });
    if (!exists) {
      await prisma.spendRequest.create({
        data: {
          workspaceId: wsId,
          requesterUserId: adminUserId,
          description: sp.desc,
          category: sp.cat,
          vendor: sp.vendor,
          amountCents: sp.amountCents,
          currency: "USD",
          status: sp.status,
          spentAt: sp.status === "PAID" ? nDaysAgo(5) : null
        }
      });
    }
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
    if (prop && prop.status === 'APPROVED') {
      const exists = await prisma.policyCorpus.findFirst({ where: { workspaceId: wsId, proposalId: prop.id } });
      if (!exists) {
        await prisma.policyCorpus.create({
          data: {
            workspaceId: wsId,
            proposalId: prop.id,
            title: pol.title,
            bodyMd: prop.bodyMd,
            circleId: pol.cId,
            acceptedAt: prop.publishedAt
          }
        });
      }
    }
  }

  console.log("✅ Seed complete! You can log in with: demo@jnj-demo.corgtex.app / demo1234");
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
