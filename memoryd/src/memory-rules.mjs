// 记忆抽取的共享规则（分类/主题实体/中文时间解析）
// 从 extract-rules.mjs 抽出，供 memoryd consolidator 复用；逻辑与原来逐字节一致。
// 改动这里会影响 memory-ingest 的规则抽取结果，务必跑 /tmp 副本比对再提交。

/* ---------- 分类 ---------- */
export const DAILY_WORDS = ['体检','医院','房租','猫粮','朋友','生日','家人','妈妈','爸爸','孩子','电影','露营','健身','跑步','聚餐','聚会','快递','外卖','购物','旅行','周末','睡觉','作息','早餐','午餐','晚餐','咖啡','猫','狗','买菜','做饭','记账','还钱','交租','打扫','洗衣','理发','看病','挂号','疫苗'];
export const WORK_PROJECT = /wwwdata|zgi|newApi|moss-ui|probe/i;

export function classify(turn, text) {
  const hit = DAILY_WORDS.find(w => text.includes(w));
  if (hit) return { cat: 'daily', why: '词典:' + hit };
  if (WORK_PROJECT.test(turn.project || '')) return { cat: 'work', why: '项目' };
  return { cat: 'work', why: '默认' };
}

/* ---------- 话题 / 实体 ---------- */
export const TOPICS = ['记忆管理','会话切换','竞品调研','AI 微信','语音模型','协议对照','费用','可视化','硬件','协作','评测','工程','生活','健康','家庭','娱乐'];
export const ENTITIES = ['Claude Code','DSH','Cumora','唯信','小米 LX06','GitHub','Codex'];

export function tagsOf(text) {
  return {
    topics: TOPICS.filter(t => text.includes(t) || (t === 'AI 微信' && text.includes('微信'))),
    entities: ENTITIES.filter(e => text.includes(e))
  };
}

/* ---------- 时间解析（相对 -> 绝对） ---------- */
const WD = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':7,'天':7 };

export function fmtDay(d) {
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}

export function addDays(base, n) { const d = new Date(base); d.setDate(d.getDate()+n); return d; }

export function parseDue(text, ts) {
  const base = new Date(ts);
  let m;
  if ((m = text.match(/(\d{1,2})月(\d{1,2})[日号]/))) {
    return `${base.getFullYear()}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  }
  if (/大后天/.test(text)) return fmtDay(addDays(base,3));
  if (/后天/.test(text)) return fmtDay(addDays(base,2));
  if (/明天/.test(text)) return fmtDay(addDays(base,1));
  if (/今天/.test(text)) return fmtDay(base);
  if ((m = text.match(/下(?:周|星期)([一二三四五六日天])/))) {
    const target = WD[m[1]];
    const cur = base.getDay() === 0 ? 7 : base.getDay();
    let delta = (target - cur + 7) % 7;
    if (delta === 0) delta = 7;
    return fmtDay(addDays(base, delta + 7));
  }
  if ((m = text.match(/(?:周|星期)([一二三四五六日天])/))) {
    const target = WD[m[1]];
    const cur = base.getDay() === 0 ? 7 : base.getDay();
    let delta = (target - cur + 7) % 7;
    if (delta === 0) delta = 7;
    return fmtDay(addDays(base, delta));
  }
  if (/月底/.test(text)) {
    const d = new Date(base.getFullYear(), base.getMonth()+1, 0);
    return fmtDay(d);
  }
  return null;
}
