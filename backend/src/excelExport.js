import fs from 'node:fs';
import JSZip from 'jszip';
import { SHEET_ALIASES } from './config.js';
import { STATUS } from './permissions.js';
import { resolveFactor } from './conversion.js';
import { HttpError, SITE_TABLES } from './service.js';
import { validateFinancialYear, validateQuarter } from './validation.js';

const xmlUnescape = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Report page groups: missingData, awaitingApproval, missingMapping, companyConfirmation. */
export const WARNING_CATEGORY = {
  MISSING_FACTOR: 'missingData',
  NOT_EXPORTED: 'awaitingApproval',
  UNMAPPED_PARAMETER: 'missingMapping',
  NO_EXPORT_MAPPING: 'missingMapping',
  NO_FACTOR_CELL: 'missingMapping',
  SHEET_ALIAS: 'companyConfirmation',
  FACTOR_REVIEW: 'companyConfirmation',
  TEMPLATE_LABELS: 'companyConfirmation',
};

/** Builds the list of cells to write, plus warnings, without touching the template. */
export function buildExportPlan(db, service, user, fy, q) {
  const e = validateFinancialYear(fy) || validateQuarter(q);
  if (e) throw new HttpError(400, e);
  const warnings = [];
  const cells = [];
  const mappings = db.prepare('SELECT * FROM EnergyExportCellMapping WHERE IsActive = 1').all();
  const aliasSeen = new Set();
  const sheetFor = (name) => {
    const s = SHEET_ALIASES[name] || name;
    if (SHEET_ALIASES[name] && !aliasSeen.has(name)) {
      aliasSeen.add(name);
      warnings.push({ code: 'SHEET_ALIAS', message: `Mapping sheet "${name}" is written to template sheet "${s}" via a configured alias; please confirm.` });
    }
    return s;
  };

  const sites = service.listSites(user);
  const pending = [];
  const noEntries = [];
  const unmapped = [];
  for (const site of sites) {
    const t = SITE_TABLES[site.kind];
    const rows = service.rowsFor(site, fy, q);
    const approved = rows.length > 0 && rows.every((r) => r.StatusID === STATUS.APPROVED);
    if (!approved) {
      pending.push({ site: site.name, status: rows.length ? 'not approved' : 'no data' });
      continue;
    }
    const siteMaps = mappings.filter((m) => m.MappingType === t.mappingType && m[t.idCol] === site.id);
    if (siteMaps.length === 0) {
      unmapped.push(site.name);
      continue;
    }
    for (const r of rows) {
      const m = siteMaps.find((x) => x.ParameterID === r.ParameterID);
      if (!m) {
        warnings.push({ code: 'UNMAPPED_PARAMETER', message: `${site.name}: parameter ${r.ParameterID} has approved data but no export cell mapping; not exported.` });
        continue;
      }
      cells.push({ sheet: sheetFor(m.WorksheetName), cell: `${m.CellColumn}${m.CellRow}`, value: r.ConsumptionValue, site: site.name, parameterId: r.ParameterID });
    }
  }
  for (const n of unmapped) warnings.push({ code: 'NO_EXPORT_MAPPING', message: `${n}: approved data exists but EnergyExportCellMapping has no rows for it; nothing exported for this location.` });
  for (const p of pending) {
    if (p.status === 'no data') noEntries.push(p.site);
    else warnings.push({ code: 'NOT_EXPORTED', message: `${p.site}: ${p.status}; cells left blank.` });
  }

  const params = service.parameters();
  const facs = service.factors();
  const convMaps = mappings.filter((m) => m.MappingType === 'ENERGY_CONVERSION');
  const missingFactors = [];
  for (const p of params) {
    const m = convMaps.find((x) => x.ParameterID === p.ParameterID);
    const r = resolveFactor(p, facs.find((f) => f.ParameterID === p.ParameterID));
    if (!r.ok) {
      missingFactors.push({ parameterId: p.ParameterID, source: p.SourceOfEnergy, problem: r.problem });
      warnings.push({ code: 'MISSING_FACTOR', message: `${p.SourceOfEnergy}: ${r.problem} Conversion cell left blank.` });
      continue;
    }
    if (!m) {
      warnings.push({ code: 'NO_FACTOR_CELL', message: `${p.SourceOfEnergy}: no conversion cell mapping; factor not written.` });
      continue;
    }
    cells.push({ sheet: sheetFor(m.WorksheetName), cell: `${m.CellColumn}${m.CellRow}`, value: r.factor, site: 'conversion', parameterId: p.ParameterID });
    if (p.ParameterID === 10) {
      warnings.push({ code: 'FACTOR_REVIEW', message: 'Any Other Fuel uses the supplied factor 1 GJ/kg, which applies to renewable and non-renewable fuels alike. Please confirm.' });
    }
  }
  if (q !== 'Q1' || fy !== 'FY26-27') {
    warnings.push({ code: 'TEMPLATE_LABELS', message: 'Template headers say "Q1 FY27" / "FY 2025-26"; header text is not modified by the export.' });
  }
  const seen = new Map();
  for (const c of cells) {
    const k = `${c.sheet}!${c.cell}`;
    if (seen.has(k)) throw new HttpError(500, `Export mapping conflict: ${k} is mapped twice.`);
    seen.set(k, true);
  }
  return { financialYear: fy, quarter: q, period: { financialYear: fy, quarter: q, label: `${fy} ${q}` }, cells, warnings: warnings.map((w) => ({ ...w, category: WARNING_CATEGORY[w.code] })), noEntries, missingFactors };
}

async function loadSheetIndex(zip) {
  const wb = await zip.file('xl/workbook.xml').async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const target = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const t = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && t) target.set(id, t);
  }
  const index = new Map();
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[0])?.[1];
    const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
    if (name && rid && target.has(rid)) index.set(xmlUnescape(name), 'xl/' + target.get(rid).replace(/^\/?(xl\/)?/, ''));
  }
  return { index, workbookXml: wb };
}

/** Writes a numeric value into an existing, non-formula cell of a worksheet XML string. */
export function setCellNumber(xml, ref, value) {
  const re = new RegExp(`<c r="${ref}"((?:\\s+[\\w:]+="[^"]*")*)\\s*(?:/>|>([\\s\\S]*?)</c>)`);
  const m = re.exec(xml);
  if (!m) throw new Error(`Cell ${ref} does not exist in the template sheet.`);
  if (m[2] && /<f[\s>/]/.test(m[2])) throw new Error(`Cell ${ref} contains a formula; refusing to overwrite.`);
  const attrs = m[1].replace(/\s+t="[^"]*"/, '');
  return xml.slice(0, m.index) + `<c r="${ref}"${attrs}><v>${String(value)}</v></c>` + xml.slice(m.index + m[0].length);
}

export async function generateWorkbook(templatePath, plan) {
  const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const { index, workbookXml } = await loadSheetIndex(zip);
  const bySheet = new Map();
  for (const c of plan.cells) {
    if (!index.has(c.sheet)) throw new HttpError(500, `Template has no sheet named "${c.sheet}".`);
    (bySheet.get(c.sheet) || bySheet.set(c.sheet, []).get(c.sheet)).push(c);
  }
  for (const [sheet, cells] of bySheet) {
    const file = index.get(sheet);
    let xml = await zip.file(file).async('string');
    for (const c of cells) {
      try {
        xml = setCellNumber(xml, c.cell, c.value);
      } catch (err) {
        throw new HttpError(500, `${sheet}: ${err.message}`);
      }
    }
    zip.file(file, xml);
  }
  // Formula results are stale after patching inputs; make Excel recalculate on open.
  const patched = /<calcPr\b[^>]*fullCalcOnLoad=/.test(workbookXml)
    ? workbookXml
    : workbookXml.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
  zip.file('xl/workbook.xml', patched);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
