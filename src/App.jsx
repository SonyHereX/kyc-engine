import { useState, useCallback, useRef, useEffect } from "react";
import { supabase } from "./supabaseClient";
import { doubleMetaphone } from "double-metaphone";
import jaroWinkler from "jaro-winkler";
import stringSimilarity from "string-similarity";

async function saveToSupabase(processedRows, onError) {
  try {
    const safeParse = (str) => {
      if (!str) return null;
      try {
        let cleanStr = str.trim();
        if (cleanStr.startsWith("'") && cleanStr.endsWith("'")) {
            cleanStr = cleanStr.slice(1, -1);
        }
        return JSON.parse(cleanStr);
      } catch (e) {
        return null;
      }
    };

    for (const item of processedRows) {
      const r = item.row;
      // 1. Insert into csv_data
      const csvPayload = {
        project_id: String(r.project_id || ""),
        campaign_name: r.campaign_name || "",
        submitted_on: r.submitted_on || "",
        category: r.category || "",
        recipient_type: r.recipient_type || "",
        withdrawal_bank_account_id: String(r.withdrawal_bank_account_id || ""),
        account_status: r.account_status || "",
        account_number: String(r.account_number || ""),
        ifsc_code: r.ifsc_code || "",
        bank_name: r.bank_name || "",
        name_as_in_bank: r.name_as_in_bank || "",
        beneficiary_name: r.beneficiary_name || "",
        co_name: r.co_name || "",
        is_fcra_account: r.is_fcra_account || "",
        swift_code: r.swift_code || "",
        relationship_with_beneficiary: r.relationship_with_beneficiary || "",
        id_proof_link: r.id_proof_link || "",
        id_proof_ocr_data: safeParse(r.id_proof_ocr_data),
        relationship_proof_link: r.relationship_proof_link || "",
        relationship_proof_ocr_data: safeParse(r.relationship_proof_ocr_data),
        amount_raised_in_inr: parseFloat(r.amount_raised_in_inr) || 0,
        id_proof_url: r.id_proof_url || r.id_proof_link || "",
        account_holder_name: r.account_holder_name || r.name_as_in_bank || "",
        relationship_type: r.relationship_type || r.relationship_with_beneficiary || "",
        recipient_name: r.recipient_name || r.name_as_in_bank || ""
      };
      
      const { data: csvData, error: csvError } = await supabase
        .from('csv_data')
        .insert([csvPayload])
        .select()
        .single();
        
      if (csvError) {
        console.error("Error inserting CSV data:", csvError);
        if (onError) {
          if (csvError.code === "42501") {
            onError("Row-Level Security (RLS) policy violation. Please disable RLS or add INSERT policies for 'csv_data' and 'kyc_decisions' in your Supabase SQL editor.");
          } else {
            onError(csvError.message || String(csvError));
          }
        }
        continue;
      }

      // 2. Insert into kyc_decisions
      const decisionPayload = {
        csv_data_id: csvData.id,
        kyc_decision: item.decision,
        rejection_reason: item.decision === "REJECT" ? item.checks.filter(c => c.status === "reject").map(c => c.detail).join(" | ") : "",
        failed_checks: item.checks.filter(c => c.status !== "pass"),
        action_required: item.checks.filter(c => c.status !== "pass").map(c => c.detail).join(" | ")
      };

      const { error: decError } = await supabase
        .from('kyc_decisions')
        .insert([decisionPayload]);
        
      if (decError) {
        console.error("Error inserting KYC decision:", decError);
        if (onError) onError(decError.message || String(decError));
      }
    }
    console.log("Supabase save complete!");
  } catch (e) {
    console.error("Supabase sync failed:", e);
    if (onError) onError(e.message || String(e));
  }
}

// â”€â”€â”€ Fuzzy name matching â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
}

const isWordSimilar = (w1, w2) => {
  if (w1 === w2) return true;
  
  const shortLen = Math.min(w1.length, w2.length);
  if (shortLen <= 2) {
    if (w1.length > w2.length && w1.startsWith(w2)) return true;
    if (w2.length > w1.length && w2.startsWith(w1)) return true;
  }

  if (w1.length < 3 || w2.length < 3) return false;
  const dist = levenshtein(w1, w2);
  const maxLen = Math.max(w1.length, w2.length);
  if (maxLen <= 4) return dist <= 1;
  if (maxLen <= 7) return dist <= 2;
  return dist <= 3;
};

function fuzzyNameMatch(a, b) {
  if (!a || !b) return false;
  const strA = String(a).trim();
  const strB = String(b).trim();
  if (!strA || !strB) return false;

  const clean = s =>
    String(s).toLowerCase()
      .replace(/\b(mr|mrs|ms|dr|prof|shri|sri|smt|kum|late|m\/s)\b\.?/gi, "")
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const ca = clean(strA), cb = clean(strB);
  if (ca === cb) return true;
  if (ca.split(" ").sort().join(" ") === cb.split(" ").sort().join(" ")) return true;
  
  const caNoSpace = ca.replace(/\s/g, "");
  const cbNoSpace = cb.replace(/\s/g, "");
  if (caNoSpace === cbNoSpace) return true;
  if (caNoSpace.length >= 8 && cbNoSpace.length >= 8) {
    if (caNoSpace.includes(cbNoSpace) || cbNoSpace.includes(caNoSpace)) return true;
  }

  // --- NEW: Advanced Algorithms ---
  
  // 1. Double Metaphone (Phonetic matching)
  // Check if primary or secondary phonetic codes match exactly
  const [metaA1, metaA2] = doubleMetaphone(caNoSpace);
  const [metaB1, metaB2] = doubleMetaphone(cbNoSpace);
  if ((metaA1 && metaA1 === metaB1) || (metaA2 && metaA2 === metaB2) || (metaA1 && metaA1 === metaB2) || (metaA2 && metaA2 === metaB1)) {
    return true;
  }

  // 2. Jaro-Winkler Distance (Typo detection)
  // Distance > 0.88 is a very strong match for human names
  const jwDist = jaroWinkler(ca, cb);
  if (jwDist > 0.88) return true;

  // 3. N-Gram Cosine Similarity (Scrambled/missing words)
  // Dice coefficient on strings
  const diceSimilarity = stringSimilarity.compareTwoStrings(ca, cb);
  if (diceSimilarity > 0.80) return true;
  
  // --- END NEW ---

  const wa = ca.split(" ").filter(Boolean), wb = cb.split(" ").filter(Boolean);
  if (wa.length === 0 || wb.length === 0) return false;
  return wa.filter(w => wb.some(wbWord => isWordSimilar(w, wbWord))).length >= Math.min(wa.length, wb.length);
}

// â”€â”€â”€ Campaign rules â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const CAMPAIGN_ALLOWED = {
  medical:                ["beneficiary","myself","family_member","treating_hospital","vendor"],
  memorial:               ["family_member","myself"],
  memorials:              ["family_member","myself"],
  educational:            ["beneficiary","myself","family_member","educational_institute"],
  education:              ["beneficiary","myself","family_member","educational_institute"],
  organization:           ["ngo"],
  organisation:           ["ngo"],
  hospital_admin:         ["beneficiary","myself","family_member","treating_hospital","vendor"],
  social:                 ["beneficiary","myself","ngo","treating_hospital","vendor"],
  social_entrepreneurship:["beneficiary","myself","ngo","treating_hospital","vendor"],
  media:                  ["beneficiary","myself"],
  arts_media:             ["beneficiary","myself"],
  arts_and_media:         ["beneficiary","myself"],
  animals:                ["beneficiary","myself"],
  emergencies:            ["beneficiary","myself","family_member"],
  sports:                 ["beneficiary","myself"],
  environment:            ["beneficiary","myself","ngo","treating_hospital","vendor"],
  children:               ["beneficiary","myself","family_member","treating_hospital","vendor"],
  others:                 ["beneficiary","myself","family_member","ngo","treating_hospital","vendor"],
  livelihood:             ["beneficiary","myself","family_member","ngo","treating_hospital","vendor"],
  women:                  ["beneficiary","myself","family_member","ngo","treating_hospital","vendor"],
};
const INDIV   = ["beneficiary","myself","family_member"];
const ORG     = ["treating_hospital","vendor","ngo","educational_institute"];
const REL_REQ = ["family_member","treating_hospital","vendor","ngo","educational_institute"];
const norm    = s => (s||"").toLowerCase().replace(/\s*&\s*/g,"_and_").replace(/\s*\/\s*/g,"_").replace(/[\s\-]+/g,"_").replace(/[^a-z0-9_]/g,"");

// Normalise recipient type â€” map aliases to canonical values
function normRecipient(r = "") {
  const n = norm(r);
  const aliases = {
    organisation: "ngo",
    organization: "ngo",
    treating_hospital: "treating_hospital",
    hospital: "treating_hospital",
    family_member: "family_member",
    educational_institute: "educational_institute",
    college: "educational_institute",
    school: "educational_institute",
  };
  return aliases[n] || n;
}

// Parse currency field â€” handles "{inr,other,usd}", "INR", "USD" etc.
// {inr,other,usd} means campaign accepts multiple currencies â€” treat as INR
// Only flag USD if currency is exclusively USD (no INR present)
function parseCurrency(raw = "") {
  const s = raw.toLowerCase();
  const hasUSD = s.includes("usd");
  const hasINR = s.includes("inr") || s.includes("other");
  if (hasUSD && !hasINR) return "USD"; // exclusively USD
  return "INR"; // INR or mixed â€” apply INR rules
}

// â”€â”€â”€ Parse pre-computed OCR data from CSV column â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Handles formats:
//   Single:   {"name":"Ravi","document_type":"Aadhaar Card","document_id":"1234"}
//   Multiple: {"name":"Ravi",...} , {"name":null,"side":"back",...}
//   Array:    [{"name":"Ravi",...},{"name":null,...}]

function parseOcrColumn(raw = "") {
  if (!raw || raw.trim() === "") return null;
  raw = raw.trim().replace(/^'+|'+$/g, "").trim().replace(/""/g, '"');

  // â”€â”€ Extract ALL name-like values from anywhere in the JSON â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Handles: flat {"name":"X"}, nested {personal_details:{name:"X"}},
  // groom_details.name, bride_details.name, family_details[].name etc.
  const allNames = [];
  const addName = (n) => {
    if (!n || typeof n !== "string") return;
    // Strip titles and relationship prefixes
    const cleaned = n.replace(/^(Sri|Smt|Kum|Mr|Mrs|Dr)\b\.?\s*|^(S\/O|W\/O|D\/O|B\/O):\s*/i, "").trim();
    if (cleaned && cleaned !== "null" && cleaned.length > 1) allNames.push(cleaned);
  };

  // Regex: find all "name": "value" or "name_before_marriage": "value" etc.
  const nameKeys = ["name","name_before_marriage","name_after_marriage","full_name","father_name","mother_name","husband_name","parent_name","beneficiary_name","recipient_name"];
  for (const key of nameKeys) {
    const re = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, "g");
    for (const m of raw.matchAll(re)) addName(m[1]);
  }

  // Also extract from family_details array (Jan Aadhaar style)
  // {"name": "RAMKARAN", "relation_to_head": "Husband"} etc.
  const familyRe = /"name"\s*:\s*"([^"]+)"/g;
  for (const m of raw.matchAll(familyRe)) addName(m[1]);

  // Dedupe preserving order
  const uniqueNames = [...new Map(allNames.map(n => [n.toLowerCase(), n])).values()];

  // â”€â”€ Try to parse full JSON for structured fields â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let docType = null, docNumber = null;
  try {
    // Try parsing as a single JSON object (new rich OCR format)
    const obj = JSON.parse(raw);
    docType = obj.document_type || null;
    docNumber = obj.personal_details?.aadhaar_number || obj.registration_no || null;
  } catch {
    // Fallback: extract doc_type from any "document_type" field
    const dtm = raw.match(/"document_type"\s*:\s*"([^"]+)"/);
    if (dtm) docType = dtm[1];
    const dnm = raw.match(/"document_id"\s*:\s*"([^"]+)"/);
    if (dnm) docNumber = dnm[1];
  }

  if (uniqueNames.length === 0 && !docType) return null;

  return {
    full_name:       uniqueNames[0] || null,
    document_type:   docType,
    document_number: docNumber,
    names_found:     uniqueNames,
    _raw_entries:    [],
  };
}

// â”€â”€â”€ KYC Engine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function runKYC(row, ocrResults = {}, llmCache = {}) {
  const checks = [];
  let decision = "APPROVE";
  const flag = lvl => { if (lvl==="REJECT") decision="REJECT"; else if (lvl==="HOLD" && decision!=="REJECT") decision="HOLD"; };

  const checkName = (a, b) => {
    if (!a || !b) return { match: false, explain: "" };
    if (fuzzyNameMatch(a, b)) return { match: true, explain: "" };
    const cleanA = String(a).trim();
    const cleanB = String(b).trim();
    const key1 = `${cleanA}||${cleanB}`;
    const key2 = `${cleanB}||${cleanA}`;
    const cached = llmCache && (llmCache[key1] || llmCache[key2]);
    if (cached?.match) {
      return { match: true, explain: " (AI Verified)" };
    }
    if (cached && !cached.match && !cached.loading) {
      return { match: false, explain: ` (AI Mismatch: ${cached.reason})` };
    }
    if (cached?.loading) {
      return { match: false, explain: " (AI Verifying...)" };
    }
    return { match: false, explain: "" };
  };

  const flagNameMismatch = (a, b) => {
    const key1 = `${String(a).trim()}||${String(b).trim()}`;
    const key2 = `${String(b).trim()}||${String(a).trim()}`;
    const cached = llmCache && (llmCache[key1] || llmCache[key2]);
    if (cached?.loading) {
      flag("HOLD");
      return "hold";
    }
    flag("REJECT");
    return "reject";
  };

  const rt         = normRecipient(row.recipient_type||"");
  const cat        = norm(row.category||"");
  const currency   = parseCurrency(row.currency||"INR");
  const isUSD      = currency === "USD";
  const isFCRA     = (row.is_fcra_account||"").toLowerCase()==="yes";
  const acctStatus = (row.account_status||"").toUpperCase();
  const nameBank   = (row.name_as_in_bank||"").trim();
  const nameUser   = (row.account_holder_name||row.name_entered_by_user||"").trim();
  const panStatus  = (row.pan_status||"").toUpperCase();
  // pan_card_number in CSV means PAN was submitted â€” treat as VALID if present
  const panNumber  = (row.pan_card_number||"").trim();
  const panName    = (row.pan_name||"").trim();
  const recipName  = (row.recipient_name||"").trim();
  const benefName  = (row.beneficiary_name||"").trim();
  const coName     = (row.co_name||"").trim();
  const gstStatus  = (row.gst_status||"").toUpperCase();
  const relProof   = (row.relationship_proof_present||"").toLowerCase();
  const isOrg      = ORG.includes(rt);
  const isIndiv    = INDIV.includes(rt);

  // OCR results
  // Column name aliases â€” support both naming conventions from real CSV
  if (!row.id_proof_url && row.id_proof_link)             row.id_proof_url = row.id_proof_link;
  if (!row.relationship_proof_url && row.relationship_proof_link) row.relationship_proof_url = row.relationship_proof_link;
  if (!row.account_holder_name && row.name_as_in_bank)    row.account_holder_name = row.name_as_in_bank;
  if (!row.gst_status && row.gstin_valid)                 row.gst_status = row.gstin_valid === "true" || row.gstin_valid === "1" ? "VALID" : (row.gstin_valid || "").toUpperCase();
  if (!row.relationship_type && row.relationship_with_beneficiary) row.relationship_type = row.relationship_with_beneficiary;
  if (!row.recipient_name && row.name_as_in_bank)         row.recipient_name = row.name_as_in_bank;

  // Use pre-computed OCR data from CSV columns if available
  // Falls back to runtime OCR results (ocrResults) if CSV OCR not present
  const idOCR  = (row.id_proof_ocr_data   ? parseOcrColumn(row.id_proof_ocr_data)           : null)
              || ocrResults.id_proof  || null;
  const relOCR = (row.relationship_proof_ocr_data ? parseOcrColumn(row.relationship_proof_ocr_data) : null)
              || ocrResults.rel_proof || null;

  // 1. Account Status
  if (["VERIFIED","VALID"].includes(acctStatus)) {
    checks.push({ id:"acct", label:"Account Status", status:"pass", detail:"Account verified by banking API." });
  } else if (["INVALID","BLOCKED"].includes(acctStatus)) {
    checks.push({ id:"acct", label:"Account Status", status:"reject", detail:"Account is invalid/blocked. User must provide a working bank account and re-raise request." });
    flag("REJECT");
  } else {
    checks.push({ id:"acct", label:"Account Status", status:"hold", detail:"Account could not be authenticated. Assign to calling team for passbook verification (resolve within 2 days)." });
    flag("HOLD");
  }

  // 2. Name Match
  if (nameBank && nameUser) {
    const res = checkName(nameBank, nameUser);
    if (res.match) {
      checks.push({ id:"name", label:"Name Match (Bank vs User)", status:"pass", detail:`"${nameUser}" matches bank record "${nameBank}"${res.explain}.` });
    } else {
      const status = flagNameMismatch(nameBank, nameUser);
      checks.push({ id:"name", label:"Name Match (Bank vs User)", status, detail:`Mismatch â€” user entered "${nameUser}", bank shows "${nameBank}"${res.explain}. Update the bank account name.` });
    }
  } else {
    checks.push({ id:"name", label:"Name Match (Bank vs User)", status:"hold", detail:"Bank name or user-entered name missing. Manual verification required." });
    flag("HOLD");
  }

  // 2b. Beneficiary name vs bank name (for beneficiary recipient type)
  // The account must belong to the actual beneficiary
  if (rt === "beneficiary" && nameBank && benefName) {
    const res = checkName(nameBank, benefName);
    if (res.match) {
      checks.push({ id:"benef_name", label:"Beneficiary Name vs Bank Account", status:"pass",
        detail:`Bank account holder "${nameBank}" matches beneficiary "${benefName}"${res.explain}.` });
    } else {
      const status = flagNameMismatch(nameBank, benefName);
      checks.push({ id:"benef_name", label:"Beneficiary Name vs Bank Account", status,
        detail:`Account holder "${nameBank}" does not match beneficiary "${benefName}"${res.explain}. For beneficiary recipient type, the beneficiary's own account must be added.` });
    }
  }

  // 3. Recipient Type vs Campaign
  const allowed = CAMPAIGN_ALLOWED[cat];
  if (allowed) {
    if (allowed.includes(rt)) {
      checks.push({ id:"rt_cat", label:"Recipient Type vs Campaign", status:"pass", detail:`"${row.recipient_type}" is permitted for "${row.category}" campaigns.` });
    } else {
      checks.push({ id:"rt_cat", label:"Recipient Type vs Campaign", status:"reject", detail:`"${row.recipient_type}" is NOT allowed for "${row.category}" campaigns. Allowed: ${allowed.join(", ")}.` });
      flag("REJECT");
    }
  } else {
    checks.push({ id:"rt_cat", label:"Recipient Type vs Campaign", status:"hold", detail:`Unknown campaign category "${row.category}". Manual review required.` });
    flag("HOLD");
  }

  // 4. Myself â€” CO name match
  if (rt === "myself") {
    if (coName && (nameUser||nameBank)) {
      // co_name may be a username/handle â€” only flag mismatch if it looks like a real name
      // A real name has letters and spaces but no digits/underscores dominating
      const looksLikeName = (s) => /^[a-zA-Z\s\.]{4,}$/.test(s.trim());
      if (!looksLikeName(coName)) {
        // co_name is a username/handle â€” can't reliably match, pass to manual
        checks.push({ id:"myself", label:"CO Name Match (Myself)", status:"hold", detail:`CO identifier "${coName}" appears to be a username, not a name. Manual verification of account ownership required.` });
        flag("HOLD");
      } else {
        const resUser = checkName(coName, nameUser);
        const resBank = checkName(coName, nameBank);
        if (resUser.match || resBank.match) {
          const explain = resUser.match ? resUser.explain : resBank.explain;
          checks.push({ id:"myself", label:"CO Name Match (Myself)", status:"pass", detail:`Account holder matches Campaign Organiser "${coName}"${explain}.` });
        } else {
          // If either is loading, treat as loading (HOLD)
          const keyUser1 = `${coName.trim()}||${nameUser.trim()}`;
          const keyUser2 = `${nameUser.trim()}||${coName.trim()}`;
          const keyBank1 = `${coName.trim()}||${nameBank.trim()}`;
          const keyBank2 = `${nameBank.trim()}||${coName.trim()}`;
          const loading = llmCache && (llmCache[keyUser1]?.loading || llmCache[keyUser2]?.loading || llmCache[keyBank1]?.loading || llmCache[keyBank2]?.loading);
          const explain = resUser.explain || resBank.explain;
          if (loading) {
            checks.push({ id:"myself", label:"CO Name Match (Myself)", status:"hold", detail:`Recipient type is "myself" but account name "${nameUser||nameBank}" doesn't match CO "${coName}"${explain}.` });
            flag("HOLD");
          } else {
            checks.push({ id:"myself", label:"CO Name Match (Myself)", status:"reject", detail:`Recipient type is "myself" but account name "${nameUser||nameBank}" doesn't match CO "${coName}"${explain}.` });
            flag("REJECT");
          }
        }
      }
    } else {
      checks.push({ id:"myself", label:"CO Name Match (Myself)", status:"hold", detail:"CO name unavailable to verify 'myself' recipient. Manual check needed." });
      flag("HOLD");
    }
  }

  // 5. ID Proof â€” Individual (with OCR)
  if (isIndiv) {
    const idUrl = row.id_proof_url || row.id_proof_1_url || "";
    if (!idUrl && !idOCR) {
      checks.push({ id:"id", label:"ID Proof (Individual)", status:"hold", detail:"No ID proof URL provided in CSV. Add id_proof_url column with the document URL." });
      flag("HOLD");
    } else if (idOCR?.error) {
      checks.push({ id:"id", label:"ID Proof (Individual)", status:"hold", detail:`ID proof error: ${idOCR.error}. Manual review required.` });
      flag("HOLD");
    } else if (idOCR?.full_name) {
      const nameToCheck = rt==="myself" ? (coName||nameUser) : (recipName||nameUser);
      const resMatch = checkName(idOCR.full_name, nameToCheck);
      const resBenMatch = benefName ? checkName(idOCR.full_name, benefName) : { match: false, explain: "" };
      
      if (resMatch.match || resBenMatch.match) {
        const explain = resMatch.match ? resMatch.explain : resBenMatch.explain;
        checks.push({ id:"id", label:"ID Proof (Individual)", status:"pass",
          detail:`${idOCR.document_type||"Document"}${idOCR.document_number?` (${idOCR.document_number})`:""}. Extracted name "${idOCR.full_name}" matches recipient/beneficiary${explain}.` });
      } else {
        // If either is loading, treat as hold
        const keyMatch1 = `${idOCR.full_name.trim()}||${nameToCheck.trim()}`;
        const keyMatch2 = `${nameToCheck.trim()}||${idOCR.full_name.trim()}`;
        const keyBen1 = benefName ? `${idOCR.full_name.trim()}||${benefName.trim()}` : "";
        const keyBen2 = benefName ? `${benefName.trim()}||${idOCR.full_name.trim()}` : "";
        const loading = llmCache && (llmCache[keyMatch1]?.loading || llmCache[keyMatch2]?.loading || (benefName && (llmCache[keyBen1]?.loading || llmCache[keyBen2]?.loading)));
        const explain = resMatch.explain || resBenMatch.explain;
        
        if (loading) {
          checks.push({ id:"id", label:"ID Proof (Individual)", status:"hold",
            detail:`Extracted name "${idOCR.full_name}" doesn't match recipient "${nameToCheck}" or beneficiary "${benefName}"${explain}. Align the recipient name with the document.` });
          flag("HOLD");
        } else {
          checks.push({ id:"id", label:"ID Proof (Individual)", status:"reject",
            detail:`Extracted name "${idOCR.full_name}" doesn't match recipient "${nameToCheck}" or beneficiary "${benefName}"${explain}. Align the recipient name with the document.` });
          flag("REJECT");
        }
      }
    } else if (idOCR) {
      // OCR ran but no name extracted â€” document may be valid, check doc number at least
      const docNum = idOCR.document_number || "";
      checks.push({ id:"id", label:"ID Proof (Individual)", status:"hold",
        detail:`ID document present${docNum ? ` (${idOCR.document_type||"Doc"}: ${docNum})` : ""} but name could not be extracted. Manual name verification required.` });
      flag("HOLD");
    } else {
      checks.push({ id:"id", label:"ID Proof (Individual)", status:"hold", detail:"ID proof data not available. Manual review required." });
      flag("HOLD");
    }
  }

  // 6. PAN â€” Org
  if (isOrg) {
    // PAN is considered submitted if: pan_card_number column has value, or pan_status set, or OCR extracted it
    const panSubmitted = panNumber || panStatus || idOCR?.pan_number;
    if (!panSubmitted) {
      checks.push({ id:"pan", label:"PAN Verification (Org)", status:"hold", detail:"PAN not submitted. Required for all organisational recipients." });
      flag("HOLD");
    } else if (panStatus === "INVALID") {
      checks.push({ id:"pan", label:"PAN Verification (Org)", status:"reject", detail:"PAN is INVALID. Provide correct PAN card details." });
      flag("REJECT");
    } else {
      const panNameToUse = idOCR?.full_name || panName;
      const panNum = idOCR?.pan_number || panNumber;
      if (panNameToUse && recipName) {
        const res = checkName(panNameToUse, recipName);
        if (res.match) {
          checks.push({ id:"pan", label:"PAN Verification (Org)", status:"pass",
            detail:`PAN${panNum ? ` (${panNum})` : ""} â€” name "${panNameToUse}" matches recipient "${recipName}"${res.explain}.` });
        } else {
          const status = flagNameMismatch(panNameToUse, recipName);
          checks.push({ id:"pan", label:"PAN Verification (Org)", status,
            detail:`PAN name "${panNameToUse}" doesn't match recipient "${recipName}"${res.explain}. Update hospital/vendor name.` });
        }
      } else {
        checks.push({ id:"pan", label:"PAN Verification (Org)", status:"pass",
          detail:`PAN submitted${panNum ? ` (${panNum})` : ""}. Name verification skipped â€” no PAN name available for matching.` });
      }
    }
  }

  // 7. GST â€” Vendor
  // gstin_valid column: "true"/"1"/true = valid. Also check gst_status.
  const gstinValid = (row.gstin_valid||"").toLowerCase();
  const gstIsValid = gstStatus === "VALID" || gstinValid === "true" || gstinValid === "1";
  if (rt === "vendor") {
    if (!gstStatus && !gstinValid) {
      checks.push({ id:"gst", label:"GST Verification (Vendor)", status:"hold", detail:"GST number not submitted. Required for vendor accounts." });
      flag("HOLD");
    } else if (gstIsValid) {
      checks.push({ id:"gst", label:"GST Verification (Vendor)", status:"pass", detail:"GST number verified as valid." });
    } else {
      checks.push({ id:"gst", label:"GST Verification (Vendor)", status:"reject", detail:"GST verification failed. Vendor must provide a valid GST invoice." });
      flag("REJECT");
    }
  }

  // 8. Relationship Proof (with OCR)
  if (REL_REQ.includes(rt)) {
    const relUrl = row.relationship_proof_url || row.rel_proof_url || "";
    if (!relUrl && !relOCR) {
      checks.push({ id:"rel", label:"Relationship Proof", status:"hold", detail:"No relationship proof URL in CSV. Add relationship_proof_url column." });
      flag("HOLD");
    } else if (relOCR?.error) {
      checks.push({ id:"rel", label:"Relationship Proof", status:"hold", detail:`Relationship proof error: ${relOCR.error}. Manual review required.` });
      flag("HOLD");
    } else if (relOCR?.names_found) {
      const names = relOCR.names_found || [];

      // Helper for list match
      const checkInList = (target, nameList) => {
        if (!target) return { match: false, explain: "" };
        const matched = nameList.find(n => fuzzyNameMatch(n, target));
        if (matched) return { match: true, explain: "" };
        
        for (const n of nameList) {
          const res = checkName(n, target);
          if (res.match) return { match: true, explain: res.explain };
        }

        const loading = nameList.some(n => {
          const key1 = `${n.trim()}||${target.trim()}`;
          const key2 = `${target.trim()}||${n.trim()}`;
          return llmCache && (llmCache[key1]?.loading || llmCache[key2]?.loading);
        });

        if (loading) {
          return { match: false, explain: " (AI Verifying...)", loading: true };
        }

        return { match: false, explain: "" };
      };

      // Partial match â€” any significant word from the name appears in any extracted name
      // Handles "Sneha S" matching "Smt. Sneha S", "Chandra Prakash" in family list etc.
      const partialMatch = (target, nameList) => {
        if (!target) return false;
        const words = String(target).toLowerCase().split(" ").filter(w => w.length > 2);
        return nameList.some(n => {
          const nWords = String(n).toLowerCase().split(" ");
          return words.some(w => nWords.some(nw => isWordSimilar(w, nw) || nw.includes(w)));
        });
      };

      const benefRes = checkInList(benefName, names);
      const benefConfirmed = benefRes.match || partialMatch(benefName, names);
      
      const recipRes = checkInList(recipName, names);
      const recipConfirmed = recipRes.match || partialMatch(recipName, names);

      const explain = (benefRes.explain || recipRes.explain) || "";

      if (benefConfirmed && recipConfirmed) {
        checks.push({ id:"rel", label:"Relationship Proof", status:"pass",
          detail:`${relOCR.document_type||"Document"} â€” both "${benefName}" and "${recipName}" confirmed${explain}. Relationship established.` });
      } else if (benefRes.loading || recipRes.loading) {
        checks.push({ id:"rel", label:"Relationship Proof", status:"hold",
          detail:`Verifying relationship proof names with AI...${explain}` });
        flag("HOLD");
      } else if (!benefConfirmed && !recipConfirmed) {
        checks.push({ id:"rel", label:"Relationship Proof", status:"reject",
          detail:`Neither beneficiary "${benefName}" nor recipient "${recipName}" found in document${explain}. Names found: ${names.join(", ")||"none"}.` });
        flag("REJECT");
      } else {
        const missing = !benefConfirmed ? `beneficiary "${benefName}"` : `recipient "${recipName}"`;
        checks.push({ id:"rel", label:"Relationship Proof", status:"reject",
          detail:`Could not confirm ${missing} in relationship document${explain}. Names found: ${names.join(", ")||"none"}.` });
        flag("REJECT");
      }
    } else if (relOCR) {
      checks.push({ id:"rel", label:"Relationship Proof", status:"hold", detail:"Relationship document OCR processed but could not extract names. Manual review required." });
      flag("HOLD");
    } else {
      checks.push({ id:"rel", label:"Relationship Proof", status:"hold", detail:"Relationship proof processing..." });
      flag("HOLD");
    }
  }

  // 9. FCRA / USD
  if (isUSD) {
    if (["media","legal"].includes(cat)) {
      checks.push({ id:"fcra", label:"USD / FCRA Compliance", status:"reject", detail:"Foreign donations are NOT permitted for media/legal campaigns." });
      flag("REJECT");
    } else if (!isFCRA && isIndiv) {
      checks.push({ id:"fcra", label:"USD / FCRA Compliance", status:"reject", detail:"USD cannot be transferred to individual accounts per FCRA guidelines. An FCRA trust account is required." });
      flag("REJECT");
    } else if (!isFCRA && rt==="vendor") {
      if (gstStatus==="VALID") {
        checks.push({ id:"fcra", label:"USD / FCRA Compliance (Vendor)", status:"pass", detail:"Vendor is GST registered â€” USD transfer permitted." });
      } else {
        checks.push({ id:"fcra", label:"USD / FCRA Compliance (Vendor)", status:"reject", detail:"Foreign donations to vendor accounts require GST registration. GST not verified." });
        flag("REJECT");
      }
    } else if (isFCRA) {
      const ifsc = (row.ifsc_code||"").toUpperCase();
      if (ifsc.startsWith("SBIN")) {
        checks.push({ id:"fcra", label:"USD / FCRA Compliance", status:"pass", detail:"FCRA account confirmed (SBI). USD transfers permitted." });
      } else {
        checks.push({ id:"fcra", label:"USD / FCRA Compliance", status:"hold", detail:"FCRA flag is YES but IFSC is not SBI Main Branch. Verify FCRA account validity." });
        flag("HOLD");
      }
    } else {
      checks.push({ id:"fcra", label:"USD / FCRA Compliance", status:"hold", detail:"USD transfer requested â€” FCRA status unclear. Manual verification required." });
      flag("HOLD");
    }
  }

  // 10. NGO same-entity
  if (rt==="ngo") {
    const cNGO = (row.campaign_ngo_name||"").trim();
    if (cNGO && recipName) {
      const res = checkName(cNGO, recipName);
      if (res.match) {
        checks.push({ id:"ngo", label:"NGO Same-Entity Rule", status:"pass", detail:`Campaign NGO and recipient NGO match${res.explain}.` });
      } else {
        const status = flagNameMismatch(cNGO, recipName);
        checks.push({ id:"ngo", label:"NGO Same-Entity Rule", status, detail:`Campaign is for "${cNGO}" but funds directed to "${recipName}"${res.explain}. Funds must go to the same NGO.` });
      }
    }
  }

  // 11. Vendor relevance
  if (rt==="vendor" && cat==="medical") {
    const vc = (row.vendor_category||"").toLowerCase();
    if (vc) {
      const medTerms = ["medical","pharmacy","diagnostic","equipment","hospital","clinic","lab","surgical","medicine","drug","health"];
      if (medTerms.some(v=>vc.includes(v))) {
        checks.push({ id:"vrel", label:"Vendor Relevance", status:"pass", detail:`Vendor category "${row.vendor_category}" is relevant to a medical campaign.` });
      } else {
        checks.push({ id:"vrel", label:"Vendor Relevance", status:"reject", detail:`Vendor "${row.vendor_category}" is not relevant to a medical campaign. Vendor must relate to the campaign purpose.` });
        flag("REJECT");
      }
    }
  }

  return { checks, decision };
}

// â”€â”€â”€ CSV Parser (RFC 4180 compliant â€” handles multi-line quoted fields) â”€â”€â”€
// Multi-line JSON in cells (e.g. relationship_proof_ocr_data) is handled correctly
function parseCSV(text) {
  // Normalize line endings
  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Parse entire file character-by-character so multi-line fields work
  function parseAll(str) {
    const rows = [];
    let i = 0;
    while (i < str.length) {
      const row = [];
      // Parse one row (may span multiple lines if fields are quoted)
      while (i <= str.length) {
        if (i === str.length) { row.push(""); break; }
        if (str[i] === '"') {
          // Quoted field
          i++; let val = "";
          while (i < str.length) {
            if (str[i] === '"') {
              if (str[i+1] === '"') { val += '"'; i += 2; } // escaped quote
              else { i++; break; }                           // end of field
            } else {
              val += str[i++];
            }
          }
          row.push(val);
          if (str[i] === ',') i++;
          else break; // end of row (newline or EOF)
        } else {
          // Unquoted field
          let val = "";
          while (i < str.length && str[i] !== ',' && str[i] !== '\n') val += str[i++];
          row.push(val.trim());
          if (str[i] === ',') i++;
          else { i++; break; } // newline = end of row
        }
      }
      if (row.length > 1 || (row.length === 1 && row[0] !== "")) rows.push(row);
    }
    return rows;
  }

  const rows = parseAll(raw);
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_]/g,""));

  return rows.slice(1)
    .filter(vals => vals.some(v => v.trim() !== ""))  // skip fully empty rows
    .filter(vals => {
      // Skip rows that are clearly not real data records
      // A real record must have at least a project_id-like value or campaign_name
      const campaignIdx = headers.indexOf("campaign_name");
      const projectIdx = headers.indexOf("project_id");
      if (campaignIdx >= 0 && vals[campaignIdx] && vals[campaignIdx].includes("support-")) return true;
      if (projectIdx >= 0 && vals[projectIdx] && /^\d+$/.test(vals[projectIdx])) return true;
      return false;
    })
    .map(vals => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (vals[i] || "").trim(); });
      return obj;
    });
}

// â”€â”€â”€ Design tokens â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SC = {
  pass:   { color:"#34d399", bg:"#022c1e", label:"PASS", icon:"âœ“" },
  reject: { color:"#f87171", bg:"#200808", label:"FAIL", icon:"âœ—" },
  hold:   { color:"#fbbf24", bg:"#1e1506", label:"HOLD", icon:"â—" },
};
const DC = {
  APPROVE: { color:"#34d399", bg:"#011a10", border:"#065f46", label:"AUTO APPROVE" },
  REJECT:  { color:"#f87171", bg:"#200808", border:"#991b1b", label:"REJECT"       },
  HOLD:    { color:"#fbbf24", bg:"#1e1506", border:"#92400e", label:"HOLD FOR REVIEW" },
};

// â”€â”€â”€ UI Components â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function Pill({ status }) {
  const c = SC[status];
  return <span style={{ display:"inline-flex", alignItems:"center", gap:4, background:c.bg, color:c.color, border:`1px solid ${c.color}35`, borderRadius:3, padding:"1px 7px", fontSize:10, fontWeight:700, letterSpacing:"0.06em", fontFamily:"monospace" }}>{c.icon} {c.label}</span>;
}
function DPill({ decision, large }) {
  const c = DC[decision]||DC.HOLD;
  return <span style={{ display:"inline-flex", alignItems:"center", background:c.bg, color:c.color, border:`1px solid ${c.border}`, borderRadius:4, padding:large?"5px 14px":"2px 8px", fontSize:large?12:10, fontWeight:800, letterSpacing:"0.07em", fontFamily:"monospace" }}>{c.label}</span>;
}

function CheckRow({ check }) {
  const [open, setOpen] = useState(false);
  const c = SC[check.status];
  return (
    <div style={{ borderBottom:"1px solid #0f1a2e", cursor:"pointer" }} onClick={()=>setOpen(!open)}>
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 16px" }}>
        <span style={{ color:c.color, fontSize:11, width:14, textAlign:"center", fontWeight:800 }}>{c.icon}</span>
        <span style={{ flex:1, fontSize:11.5, color:"#cbd5e1", fontFamily:"monospace" }}>{check.label}</span>
        <Pill status={check.status} />
        <span style={{ color:"#2d3a50", fontSize:10, marginLeft:2 }}>{open?"â–²":"â–¼"}</span>
      </div>
      {open && <div style={{ padding:"2px 16px 10px 40px", fontSize:11, color:"#64748b", lineHeight:1.7 }}>{check.detail}</div>}
    </div>
  );
}

function CaseCard({ row, decision, isSelected, onSelect }) {
  const c = DC[decision];
  return (
    <div onClick={onSelect} style={{ padding:"10px 14px", cursor:"pointer", background:isSelected?"#0a1525":"transparent", borderLeft:isSelected?`3px solid ${c.color}`:"3px solid transparent", borderBottom:"1px solid #0d1829", transition:"background 0.1s" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:3 }}>
        <span style={{ fontSize:11.5, color:"#e2e8f0", fontWeight:600, fontFamily:"monospace", maxWidth:155, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {row.campaign_name||row.campaign||"Campaign"}
        </span>
        <DPill decision={decision} />
      </div>
      <div style={{ fontSize:10, color:"#374151" }}>{row.category||"â€”"} Â· {row.recipient_type||"â€”"}</div>
    </div>
  );
}

// â”€â”€â”€ Demo data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const DEMO = [
  { campaign_name:"support-bhagyavathi-duriseati", category:"Medical", recipient_type:"vendor", account_number:"23030200002897", ifsc_code:"FDRL0002303", bank_name:"Federal Bank", name_entered_by_user:"SRI JOSHNAV MEDICAL AND SURGICALS", name_as_in_bank:"SRI JOSHNAV MEDICAL AND SURGICALS", account_status:"VERIFIED", beneficiary_name:"Bhagyavathi Duriseati", recipient_name:"DURGYALA SHRAVAN", co_name:"Durgyala Shravan", currency:"INR", pan_status:"VALID", pan_name:"DURGYALA SHRAVAN", gst_status:"VALID", is_fcra_account:"No", relationship_proof_present:"yes", relationship_beneficiary_name_match:"yes", relationship_recipient_name_match:"yes", vendor_category:"medical surgical", id_proof_url:"", relationship_proof_url:"" },
  { campaign_name:"support-stray-animals-967", category:"Animals", recipient_type:"myself", account_number:"20266929280", ifsc_code:"SBIN0016332", bank_name:"State Bank of India", name_entered_by_user:"Samira Fernandez", name_as_in_bank:"MRS SAMIRA FERNANDEZ", account_status:"VERIFIED", beneficiary_name:"Stray Animals", recipient_name:"Samira Fernandez", co_name:"Samira Fernandez", currency:"INR", is_fcra_account:"No", id_proof_url:"", id_proof_type:"Passport" },
  { campaign_name:"support-kamlesh-137", category:"Medical", recipient_type:"beneficiary", account_number:"9876543210", ifsc_code:"HDFC0001234", bank_name:"HDFC Bank", name_entered_by_user:"Kamlesh Sharma", name_as_in_bank:"KAMLESH SHARMA", account_status:"VERIFIED", beneficiary_name:"Kamlesh Sharma", recipient_name:"Kamlesh Sharma", co_name:"Priya Sharma", currency:"INR", is_fcra_account:"No", id_proof_url:"", id_proof_type:"Aadhaar" },
  { campaign_name:"support-child-of-lata-yamanu", category:"Education", recipient_type:"family_member", account_number:"1234567890", ifsc_code:"ICIC0001234", bank_name:"ICICI Bank", name_entered_by_user:"Lata Yamanu", name_as_in_bank:"LATA YAMANU", account_status:"VERIFIED", beneficiary_name:"Aryan Yamanu", recipient_name:"Lata Yamanu", co_name:"Lata Yamanu", currency:"INR", is_fcra_account:"No", id_proof_url:"", relationship_proof_url:"" },
  { campaign_name:"support-animals-10020-vendor-mismatch", category:"Animals", recipient_type:"vendor", account_number:"9988776655", ifsc_code:"AXIS0001234", bank_name:"Axis Bank", name_entered_by_user:"Sunrise School Supplies", name_as_in_bank:"SUNRISE SCHOOL SUPPLIES", account_status:"VERIFIED", beneficiary_name:"Stray Dogs NGO", recipient_name:"Sunrise School Supplies", co_name:"Ravi Kumar", currency:"INR", pan_status:"VALID", pan_name:"SUNRISE SCHOOL SUPPLIES", gst_status:"VALID", is_fcra_account:"No", vendor_category:"school stationery", id_proof_url:"", relationship_proof_url:"" },
];

// â”€â”€â”€ Asynchronous AI Name Match & Supabase Sync â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function verifyNameWithNvidia(nameA, nameB) {
  try {
    const res = await fetch("/api/nvidia", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ nameA, nameB })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data;
  } catch (err) {
    console.error("verifyNameWithNvidia error:", err);
    return { match: false, reason: err.message };
  }
}

async function updateCaseInSupabase(row, decision, checks) {
  try {
    const { data: csvData, error: csvError } = await supabase
      .from('csv_data')
      .select('id')
      .eq('project_id', String(row.project_id || ""))
      .limit(1)
      .single();
      
    if (csvError || !csvData) {
      console.error("Could not find csv_data record to update:", csvError);
      return;
    }

    const decisionPayload = {
      kyc_decision: decision,
      rejection_reason: decision === "REJECT" ? checks.filter(c => c.status === "reject").map(c => c.detail).join(" | ") : "",
      failed_checks: checks.filter(c => c.status !== "pass"),
      action_required: checks.filter(c => c.status !== "pass").map(c => c.detail).join(" | ")
    };

    const { error: decError } = await supabase
      .from('kyc_decisions')
      .update(decisionPayload)
      .eq('csv_data_id', csvData.id);
      
    if (decError) {
      console.error("Error updating KYC decision in Supabase:", decError);
    } else {
      console.log(`Updated decision for project ${row.project_id} to ${decision} in Supabase`);
    }
  } catch (e) {
    console.error("Failed to sync updated decision to Supabase:", e);
  }
}

// â”€â”€â”€ Main App â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function KYCEngine() {
  const [cases, setCases]         = useState([]);
  const [ocrStore, setOcrStore]   = useState({});      // { rowIndex: { id_proof, rel_proof } }
  const [selected, setSelected]   = useState(null);
  const [filter, setFilter]       = useState("ALL");
  const [search, setSearch]       = useState("");
  const [isDrag, setIsDrag]       = useState(false);
  const fileRef = useRef();
  const abortRef = useRef(false);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [llmCache, setLlmCache]   = useState({});      // { "nameA||nameB": { loading, match, reason } }
  const [dbError, setDbError]     = useState(null);


  // Run checks for all cases with pause support
  const runAllChecks = useCallback(async () => {
    abortRef.current = false;
    setIsBatchRunning(true);
    for (let i = 0; i < cases.length; i++) {
      if (abortRef.current) break;
      setSelected(i);
      setOcrStore(s => ({ ...s, [i]: { _checked: true } }));
      // small delay so UI updates are visible
      await new Promise(r => setTimeout(r, 80));
    }
    setIsBatchRunning(false);
  }, [cases]);

  const pauseChecks = useCallback(() => {
    abortRef.current = true;
    setIsBatchRunning(false);
  }, []);

  const handleFile = useCallback((file) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = async (e) => {
      const rows = parseCSV(e.target.result);
      if (rows.length) {
        // Debug: log first row's OCR fields to console
        const first = rows.find(r => r.id_proof_ocr_data);
        if (first) {
          console.log("=== OCR DEBUG ===");
          console.log("raw id_proof_ocr_data:", JSON.stringify(first.id_proof_ocr_data));
          console.log("first char code:", first.id_proof_ocr_data?.charCodeAt(0));
          const parsed = parseOcrColumn(first.id_proof_ocr_data);
          console.log("parsed result:", parsed);
        }
        setCases(rows); setOcrStore({}); setSelected(null);
        setDbError(null);
        
        // Calculate decisions to upload to Supabase
        const processedRows = rows.map((row, i) => ({
          row, index: i,
          ocr: {},
          ...runKYC(row, {}, {}),
        }));
        
        await saveToSupabase(processedRows, setDbError);
      }
    };
    r.readAsText(file);
  }, []);

  // Compute decisions
  const processed = cases.map((row, i) => ({
    row, index: i,
    ocr: ocrStore[i] || {},
    ...runKYC(row, ocrStore[i] || {}, llmCache),
  }));

  // Auto-trigger LLM verification for selected case
  useEffect(() => {
    if (selected === null || !processed[selected]) return;
    const sel = processed[selected];
    
    const pairsToVerify = [];
    const addPair = (a, b) => {
      if (!a || !b) return;
      const cleanA = String(a).trim();
      const cleanB = String(b).trim();
      if (!cleanA || !cleanB) return;
      if (fuzzyNameMatch(cleanA, cleanB)) return;
      const key = `${cleanA}||${cleanB}`;
      if (llmCache[key]) return; // already in cache or loading
      pairsToVerify.push([cleanA, cleanB]);
    };

    const r = sel.row;
    const rt         = normRecipient(r.recipient_type||"");
    const isIndiv    = INDIV.includes(rt);
    const isOrg      = ORG.includes(rt);
    const nameBank   = (r.name_as_in_bank||"").trim();
    const nameUser   = (r.account_holder_name||r.name_entered_by_user||"").trim();
    const benefName  = (r.beneficiary_name||"").trim();
    const coName     = (r.co_name||"").trim();
    const recipName  = (r.recipient_name||"").trim();
    
    const idOCR  = (r.id_proof_ocr_data   ? parseOcrColumn(r.id_proof_ocr_data)           : null)
                || sel.ocr?.id_proof  || null;
    const relOCR = (r.relationship_proof_ocr_data ? parseOcrColumn(r.relationship_proof_ocr_data) : null)
                || sel.ocr?.rel_proof || null;

    addPair(nameBank, nameUser);

    if (rt === "beneficiary") {
      addPair(nameBank, benefName);
    }

    if (rt === "myself") {
      addPair(coName, nameUser);
      addPair(coName, nameBank);
    }

    if (isIndiv && idOCR?.full_name) {
      const nameToCheck = rt==="myself" ? (coName||nameUser) : (recipName||nameUser);
      addPair(idOCR.full_name, nameToCheck);
      addPair(idOCR.full_name, benefName);
    }

    if (isOrg) {
      const panNameCol  = (r.pan_name||"").trim();
      const panNameToUse = idOCR?.full_name || panNameCol;
      addPair(panNameToUse, recipName);
    }

    if (rt === "ngo") {
      const cNGO = (r.campaign_ngo_name||"").trim();
      addPair(cNGO, recipName);
    }

    if (REL_REQ.includes(rt) && relOCR?.names_found) {
      const names = relOCR.names_found || [];
      const hasBenef = benefName && names.some(n => fuzzyNameMatch(n, benefName));
      if (!hasBenef && benefName) {
        names.forEach(n => addPair(n, benefName));
      }
      const hasRecip = recipName && names.some(n => fuzzyNameMatch(n, recipName));
      if (!hasRecip && recipName) {
        names.forEach(n => addPair(n, recipName));
      }
    }

    pairsToVerify.forEach(([a, b]) => {
      const key = `${a}||${b}`;
      setLlmCache(prev => ({
        ...prev,
        [key]: { loading: true, match: false, reason: "Checking with AI..." }
      }));

      verifyNameWithNvidia(a, b).then(res => {
        setLlmCache(prev => {
          const next = {
            ...prev,
            [key]: { loading: false, match: res.match, reason: res.reason }
          };
          
          if (res.match) {
            const updatedOcr = ocrStore[selected] || {};
            const { decision: newDecision, checks: newChecks } = runKYC(r, updatedOcr, next);
            if (newDecision !== sel.decision) {
              updateCaseInSupabase(r, newDecision, newChecks);
            }
          }
          return next;
        });
      });
    });

  }, [selected, cases]);

  const summary = {
    APPROVE: processed.filter(c=>c.decision==="APPROVE").length,
    REJECT:  processed.filter(c=>c.decision==="REJECT").length,
    HOLD:    processed.filter(c=>c.decision==="HOLD").length,
  };

  const filtered = processed.filter(({ row, decision }) => {
    const mf = filter==="ALL" || decision===filter;
    const q  = search.toLowerCase();
    const ms = !q
      || (row.campaign_name||row.campaign||"").toLowerCase().includes(q)
      || (row.category||"").toLowerCase().includes(q)
      || (row.recipient_type||"").toLowerCase().includes(q);
    return mf && ms;
  });

  const downloadSample = () => {
    const headers = [
      "campaign_name","category","recipient_type","currency",
      "account_status","account_number","ifsc_code","bank_name",
      "name_as_in_bank","account_holder_name","beneficiary_name",
      "recipient_name","co_name","is_fcra_account",
      "id_proof_url","id_proof_type",
      "relationship_proof_url",
      "pan_status","pan_name",
      "gst_status","vendor_category",
      "campaign_ngo_name","swift_code","routing_number"
    ];
    const samples = [
      ["support-ravi-kumar-medical","Medical","beneficiary","INR","VERIFIED","9876543210","HDFC0001234","HDFC Bank","RAVI KUMAR","Ravi Kumar","Ravi Kumar","Ravi Kumar","Priya Kumar","No","https://your-public-url.com/aadhaar_front.jpg","Aadhaar","","","","","","","",""],
      ["support-anita-sharma-family","Medical","family_member","INR","VERIFIED","1122334455","ICIC0005678","ICICI Bank","ANITA SHARMA","Anita Sharma","Rakesh Sharma","Anita Sharma","Anita Sharma","No","https://your-public-url.com/pan_card.jpg","PAN","https://your-public-url.com/birth_cert.jpg","","","","","","",""],
      ["support-city-hospital","Medical","treating_hospital","INR","VERIFIED","2233445566","SBIN0009999","SBI","CITY HOSPITAL AND RESEARCH","City Hospital And Research","Meena Patel","City Hospital And Research","Suresh Patel","No","https://your-public-url.com/pan_hospital.jpg","PAN","https://your-public-url.com/estimation_letter.jpg","VALID","CITY HOSPITAL AND RESEARCH","","","","",""],
      ["support-medical-vendor","Medical","vendor","INR","VERIFIED","3344556677","AXIS0001234","Axis Bank","SRI JOSHNAV MEDICAL AND SURGICALS","Sri Joshnav Medical And Surgicals","Bhagyavathi D","Sri Joshnav Medical And Surgicals","Durgyala Shravan","No","https://your-public-url.com/pan_vendor.jpg","PAN","https://your-public-url.com/gst_invoice.jpg","VALID","SRI JOSHNAV MEDICAL AND SURGICALS","VALID","medical surgical","","",""],
      ["support-stray-animals","Animals","myself","INR","VERIFIED","4455667788","SBIN0016332","State Bank of India","MRS SAMIRA FERNANDEZ","Samira Fernandez","Stray Animals","Samira Fernandez","Samira Fernandez","No","https://your-public-url.com/passport.jpg","Passport","","","","","","","",""],
      ["support-child-education","Education","family_member","INR","VERIFIED","5566778899","PUNB0001234","Punjab National Bank","LATA YAMANU","Lata Yamanu","Aryan Yamanu","Lata Yamanu","Lata Yamanu","No","https://your-public-url.com/voter_id.jpg","Voter ID","https://your-public-url.com/birth_cert_child.jpg","","","","","","",""],
      ["support-ngo-orphans","Social","ngo","INR","VERIFIED","6677889900","HDFC0009876","HDFC Bank","HOPE FOUNDATION TRUST","Hope Foundation Trust","Orphan Children","Hope Foundation Trust","Ramesh Nair","No","https://your-public-url.com/pan_ngo.jpg","PAN","","VALID","HOPE FOUNDATION TRUST","","","Hope Foundation Trust","",""],
      ["support-usd-fcra","Medical","treating_hospital","USD","VERIFIED","7788990011","SBIN0000001","State Bank of India","NATIONAL CANCER TRUST","National Cancer Trust","Suresh Mehta","National Cancer Trust","Kavita Mehta","Yes","https://your-public-url.com/pan_trust.jpg","PAN","https://your-public-url.com/fcra_cert.jpg","VALID","NATIONAL CANCER TRUST","","","","SBININBB",""],
    ];
    const csv = [headers.join(","), ...samples.map(r => r.map(v=>`"${v}"`).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    a.download = "kyc_engine_sample.csv"; a.click();
  };

  const exportCSV = () => {
    const rows = processed.map(({ row, decision, checks }) => ({
      ...row,
      kyc_decision:    decision,
      failed_checks:   checks.filter(c=>c.status!=="pass").map(c=>c.label).join("; "),
      action_required: checks.filter(c=>c.status!=="pass").map(c=>c.detail).join(" | "),
    }));
    const h = Object.keys(rows[0]);
    const csv = [h.join(","), ...rows.map(r=>h.map(k=>`"${(r[k]||"").toString().replace(/"/g,'""')}"`).join(","))].join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    a.download = `kyc_results_${Date.now()}.csv`; a.click();
  };

  const selRow = processed[selected];

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100vh", background:"#050c1a", color:"#e2e8f0", fontFamily:"'DM Mono','Courier New',monospace" }}>

      {dbError && (
        <div style={{ background: "#2a1515", borderBottom: "1px solid #7a1515", color: "#f87171", padding: "10px 20px", fontSize: 11, display: "flex", justifyContent: "space-between", alignItems: "center", zIndex: 100, flexShrink: 0 }}>
          <span>âš ï¸ <strong>Database Sync Issue:</strong> {dbError}</span>
          <button onClick={() => setDbError(null)} style={{ background: "transparent", border: "none", color: "#f87171", cursor: "pointer", fontSize: 14, fontWeight: "bold", padding: "0 5px" }}>Ã—</button>
        </div>
      )}

      {/* â”€â”€ Top bar â”€â”€ */}
      <div style={{ height:50, padding:"0 20px", display:"flex", alignItems:"center", justifyContent:"space-between", borderBottom:"1px solid #0d1829", background:"#060d1e", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:26, height:26, borderRadius:6, background:"linear-gradient(135deg,#6366f1,#8b5cf6)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:900, color:"#fff" }}>K</div>
          <span style={{ fontSize:12, fontWeight:700, color:"#f1f5f9", letterSpacing:"0.07em" }}>KYC ENGINE</span>
          <span style={{ fontSize:10, color:"#1e2d45", letterSpacing:"0.06em" }}>/ MILAAP VERIFICATIONS</span>
        </div>
        <div style={{ display:"flex", gap:12, alignItems:"center" }}>
          <div style={{ display:"flex", gap:14, fontSize:11 }}>
            {Object.entries(summary).map(([k,v])=>(
              <span key={k} style={{ color:DC[k].color }}>{v} <span style={{ opacity:0.5 }}>{k}</span></span>
            ))}
          </div>
          {isBatchRunning
            ? <button onClick={pauseChecks} style={{ background:"#1c1506", border:"1px solid #78350f", color:"#fbbf24", padding:"4px 12px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"monospace" }}>â¸ Pause</button>
            : <button onClick={runAllChecks} disabled={cases.length===0} style={{ background:"#0c1e38", border:"1px solid #1a3560", color:cases.length===0?"#1e2d45":"#60a5fa", padding:"4px 12px", borderRadius:4, cursor:cases.length===0?"not-allowed":"pointer", fontSize:11, fontFamily:"monospace" }}>â–¶ Run Checks</button>
          }
          <button onClick={downloadSample} style={{ background:"#0e1e30", border:"1px solid #1a2d45", color:"#64748b", padding:"4px 12px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"monospace" }}>
            â†“ Sample CSV
          </button>
          <button onClick={exportCSV} style={{ background:"#0e1e30", border:"1px solid #1a2d45", color:"#94a3b8", padding:"4px 12px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"monospace" }}>
            â†“ Export Results
          </button>
          <button onClick={()=>fileRef.current?.click()} style={{ background:"#0f1e38", border:"1px solid #1e3a6e", color:"#818cf8", padding:"4px 12px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"monospace" }}>
            â†‘ Upload CSV
          </button>
          <input ref={fileRef} type="file" accept=".csv" style={{ display:"none" }} onChange={e=>handleFile(e.target.files[0])} />
        </div>
      </div>

      <div style={{ display:"flex", flex:1, overflow:"hidden" }}>

        {/* â”€â”€ Sidebar â”€â”€ */}
        <div style={{ width:295, flexShrink:0, borderRight:"1px solid #0d1829", display:"flex", flexDirection:"column", background:"#040b18" }}
          onDragOver={e=>{e.preventDefault();setIsDrag(true);}}
          onDragLeave={()=>setIsDrag(false)}
          onDrop={e=>{e.preventDefault();setIsDrag(false);const f=e.dataTransfer.files[0];if(f?.name.endsWith(".csv"))handleFile(f);}}>

          <div style={{ padding:"10px 12px", borderBottom:"1px solid #0d1829" }}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search campaigns..." style={{ width:"100%", background:"#090f1e", border:"1px solid #152030", borderRadius:4, padding:"6px 9px", color:"#94a3b8", fontSize:11, fontFamily:"monospace", outline:"none", boxSizing:"border-box", marginBottom:7 }} />
            <div style={{ display:"flex", gap:3 }}>
              {["ALL","APPROVE","HOLD","REJECT"].map(f=>(
                <button key={f} onClick={()=>setFilter(f)} style={{ flex:1, padding:"3px 0", borderRadius:3, cursor:"pointer", fontSize:9, fontFamily:"monospace", fontWeight:700, letterSpacing:"0.03em", border:"1px solid", borderColor:filter===f?(DC[f]?.color||"#6366f1")+"50":"#152030", background:filter===f?(DC[f]?.bg||"#090f1e"):"transparent", color:filter===f?(DC[f]?.color||"#6366f1"):"#334155" }}>
                  {f==="ALL"?`ALL (${cases.length})`:`${f} (${summary[f]||0})`}
                </button>
              ))}
            </div>
          </div>

          <div style={{ flex:1, overflowY:"auto", position:"relative" }}>
            {filtered.map(({ row, decision, index, isProcessing }) => (
              <CaseCard key={index} row={row} decision={decision} isSelected={index===selected} onSelect={()=>setSelected(index)} />
            ))}
            {cases.length===0 && (
              <div style={{ padding:32, textAlign:"center" }}>
                <div style={{ fontSize:22, marginBottom:10 }}>ðŸ“‚</div>
                <div style={{ fontSize:11, color:"#1e2d45", lineHeight:1.7 }}>No cases loaded.<br/>Upload a CSV to begin.</div>
              </div>
            )}
            {cases.length>0 && filtered.length===0 && <div style={{ padding:24, textAlign:"center", color:"#1e2d45", fontSize:11 }}>No cases match filter</div>}
            {isDrag && (
              <div style={{ position:"absolute", inset:6, background:"#0c2040cc", display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, color:"#60a5fa", border:"2px dashed #2563eb", borderRadius:6 }}>
                Drop CSV to load
              </div>
            )}
          </div>
        </div>

        {/* â”€â”€ Detail Panel â”€â”€ */}
        {selRow ? (
          <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>

            {/* Header */}
            <div style={{ padding:"16px 24px", borderBottom:"1px solid #0d1829", background:"#050c1a", flexShrink:0 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
                <div>
                  <div style={{ fontSize:15, fontWeight:700, color:"#f1f5f9", fontFamily:"monospace", marginBottom:2 }}>
                    {selRow.row.campaign_name||selRow.row.campaign||"Campaign"}
                  </div>
                  <div style={{ fontSize:10.5, color:"#334155" }}>
                    {[selRow.row.category, selRow.row.recipient_type, selRow.row.currency||"INR"].filter(Boolean).join(" Â· ")}
                  </div>
                </div>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:6 }}>
                  <DPill decision={selRow.decision} large />
                  <div style={{ fontSize:10, color:"#334155", fontFamily:"monospace" }}>
                    {selRow.checks.filter(c=>c.status==="pass").length}âœ“&nbsp;
                    {selRow.checks.filter(c=>c.status==="reject").length}âœ—&nbsp;
                    {selRow.checks.filter(c=>c.status==="hold").length}â—
                  </div>
                </div>
              </div>
              {/* Progress bar */}
              <div style={{ display:"flex", gap:1, height:3, borderRadius:2, overflow:"hidden" }}>
                {selRow.checks.map((ch,i)=><div key={i} style={{ flex:1, background:SC[ch.status].color+"60" }} />)}
              </div>
            </div>

            <div style={{ flex:1, overflow:"auto" }}>
              {/* Info grid */}
              <div style={{ padding:"14px 24px", borderBottom:"1px solid #0d1829", display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"8px 20px" }}>
                {[["Beneficiary",selRow.row.beneficiary_name],["Recipient",selRow.row.recipient_name],["CO Name",selRow.row.co_name],["Account No.",selRow.row.account_number],["IFSC",selRow.row.ifsc_code],["Bank",selRow.row.bank_name],["Name (User)",selRow.row.account_holder_name||selRow.row.name_entered_by_user],["Name (Bank)",selRow.row.name_as_in_bank],["FCRA",selRow.row.is_fcra_account]].map(([l,v])=>v?(
                  <div key={l}>
                    <div style={{ fontSize:9, color:"#1e2d45", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:1 }}>{l}</div>
                    <div style={{ fontSize:11.5, color:"#94a3b8", fontFamily:"monospace" }}>{v}</div>
                  </div>
                ):null)}
              </div>

              {/* Checks */}
              <div>
                <div style={{ padding:"10px 16px 5px", fontSize:9.5, color:"#1e2d45", textTransform:"uppercase", letterSpacing:"0.1em", fontWeight:700 }}>
                  Verification Checks ({selRow.checks.length})
                </div>
                {selRow.checks.map(ch=><CheckRow key={ch.id} check={ch} />)}
              </div>

              {/* Action reasons */}
              {selRow.checks.filter(c=>c.status!=="pass").length>0 && (
                <div style={{ padding:"14px 24px", borderTop:"1px solid #0d1829", background:DC[selRow.decision]?.bg }}>
                  <div style={{ fontSize:9.5, color:DC[selRow.decision]?.color, textTransform:"uppercase", letterSpacing:"0.1em", fontWeight:700, marginBottom:8 }}>
                    {selRow.decision==="REJECT"?"Rejection Reasons":"Action Required"}
                  </div>
                  {selRow.checks.filter(c=>c.status!=="pass").map((x,i)=>(
                    <div key={i} style={{ fontSize:11, color:"#94a3b8", marginBottom:5, paddingLeft:10, borderLeft:`2px solid ${DC[selRow.decision]?.color}40`, lineHeight:1.6 }}>{x.detail}</div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", color:"#1e2d45", fontSize:12, gap:10 }}>
            {cases.length===0
              ? <><div style={{ fontSize:32 }}>â¬†</div><div style={{ fontSize:13, color:"#2d3a50" }}>Upload a CSV to get started</div><div style={{ fontSize:11, color:"#1e2d45", marginTop:4 }}>Click "Upload CSV" in the top right</div></>
              : <div>Select a case from the list</div>
            }
          </div>
        )}
      </div>
    </div>
  );
}
