// Shared city resolution and post-scrape location guards.
(function () {
  const root = globalThis.JobCopilotCore = globalThis.JobCopilotCore || {};
  const NATIONAL_CODE = '100010000';

  function clean(value) {
    return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
  }

  function compact(value) {
    return clean(value)
      .replace(/[\s·•/、,，]+/g, '')
      .replace(/(?:特别行政区|自治区|自治州|省|市|区|县)/g, '');
  }

  function cityEntries(cityMap) {
    return Object.keys(cityMap || {})
      .filter(name => name && name !== '全国' && cityMap[name])
      .sort((a, b) => b.length - a.length)
      .map(name => ({ name, code: String(cityMap[name]) }));
  }

  function normalizeCityName(value, cityMap) {
    const raw = clean(value);
    if (!raw) return '';
    if (/全国/.test(raw)) return '全国';
    const rawCompact = compact(raw);
    const matched = cityEntries(cityMap).find(entry => rawCompact.indexOf(compact(entry.name)) >= 0);
    if (matched) return matched.name;
    return raw.split(/[\/、,，\s]+/)[0].replace(/[市省]$/, '');
  }

  function resolveConfiguredCity(value, cityMap) {
    const raw = clean(value);
    if (!raw || /全国/.test(raw)) {
      return { found: true, name: '全国', code: NATIONAL_CODE, source: raw ? 'config' : 'config-blank' };
    }
    const name = normalizeCityName(raw, cityMap);
    const code = cityMap && cityMap[name] ? String(cityMap[name]) : '';
    return { found: !!code, name: name, code: code, source: 'config' };
  }

  function cityNameFromCode(code, cityMap) {
    const wanted = clean(code);
    const entry = cityEntries(cityMap).find(item => item.code === wanted);
    return entry ? entry.name : (wanted === NATIONAL_CODE ? '全国' : '');
  }

  function validCityCode(value) {
    const code = clean(value);
    return /^(?:100010000|101\d{6})$/.test(code) ? code : '';
  }

  function cityMapFromBossData(payload, baseMap) {
    const map = Object.assign({}, baseMap || {});
    map['全国'] = map['全国'] || NATIONAL_CODE;
    const groups = payload && payload.zpData && Array.isArray(payload.zpData.cityGroup)
      ? payload.zpData.cityGroup
      : [];
    groups.forEach(group => {
      (Array.isArray(group && group.cityList) ? group.cityList : []).forEach(city => {
        const name = clean(city && city.name);
        const code = validCityCode(city && city.code);
        if (name && code) map[name] = code;
      });
    });
    return map;
  }

  function detectJobCity(job, targetName, cityMap) {
    job = job || {};
    const direct = normalizeCityName(job.city, cityMap);
    if (direct && direct !== '全国') return direct;
    const text = clean([
      job.detailLocation,
      job.workAddress,
      job.address,
      job.location,
      job.rawLocation,
      job.rawText
    ].filter(Boolean).join(' '));
    if (!text) return '';
    const target = normalizeCityName(targetName, cityMap);
    if (target && target !== '全国' && compact(text).indexOf(compact(target)) >= 0) return target;
    if (typeof root.inferCity === 'function') {
      const inferred = normalizeCityName(root.inferCity(text), cityMap);
      if (inferred) return inferred;
    }
    const matched = cityEntries(cityMap).find(entry => compact(text).indexOf(compact(entry.name)) >= 0);
    return matched ? matched.name : '';
  }

  function guardJobsForCity(jobs, target, cityMap) {
    const list = Array.isArray(jobs) ? jobs : [];
    const targetName = normalizeCityName(target && target.name, cityMap);
    if (!targetName || targetName === '全国' || (target && target.code) === NATIONAL_CODE) {
      return { jobs: list.slice(), mismatches: [], unverified: [] };
    }
    const kept = [];
    const mismatches = [];
    const unverified = [];
    list.forEach(job => {
      const detected = detectJobCity(job, targetName, cityMap);
      if (detected && detected !== targetName) {
        mismatches.push(Object.assign({}, job, { detectedCity: detected }));
        return;
      }
      if (!detected) {
        const flags = Array.isArray(job.riskFlags) ? job.riskFlags.slice() : [];
        if (flags.indexOf('城市未识别，请人工确认') < 0) flags.push('城市未识别，请人工确认');
        const marked = Object.assign({}, job, { cityCheck: 'unverified', riskFlags: flags, risks: flags.slice() });
        unverified.push(marked);
        kept.push(marked);
        return;
      }
      const flags = (Array.isArray(job.riskFlags) ? job.riskFlags : [])
        .filter(flag => flag !== '城市未识别，请人工确认');
      kept.push(Object.assign({}, job, {
        cityCheck: 'matched',
        city: job.city || detected,
        riskFlags: flags,
        risks: flags.slice()
      }));
    });
    return { jobs: kept, mismatches, unverified };
  }

  root.city = {
    NATIONAL_CODE,
    normalizeCityName,
    resolveConfiguredCity,
    cityNameFromCode,
    validCityCode,
    cityMapFromBossData,
    detectJobCity,
    guardJobsForCity
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.city;
})();
