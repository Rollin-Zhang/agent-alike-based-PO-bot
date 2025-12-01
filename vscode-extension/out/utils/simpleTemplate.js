"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderTemplate = renderTemplate;
/**
 * 超輕量模板渲染：
 * - 變數：{{ var }}
 * - 陣列迴圈：{% for item in listVar %} ... {{ item }} ... {% endfor %}
 *   （僅支援單層，區塊內的 {{ item }} 會被逐一替換；
 *    區塊內也可引用其它 {{ someVar }}，會在每次迭代時一併處理）
 */
function renderTemplate(tpl, vars) {
    if (!tpl)
        return '';
    let out = tpl;
    // 先處理 for 迴圈
    // {% for x in list %} ... {{ x }} ... {% endfor %}
    const forRe = /{%\s*for\s+(\w+)\s+in\s+(\w+)\s*%}([\s\S]*?){%\s*endfor\s*%}/g;
    out = out.replace(forRe, (_m, itemVar, listVar, body) => {
        const list = vars[listVar];
        if (!Array.isArray(list) || list.length === 0)
            return '';
        return list.map((val) => {
            // 迴圈體內：先替換 {{ itemVar }}，再進一步替換其它 {{ xxx }}
            let segment = body.replace(new RegExp(`{{\\s*${escapeReg(itemVar)}\\s*}}`, 'g'), safeToString(val));
            segment = replaceScalars(segment, vars);
            return segment;
        }).join('');
    });
    // 再處理一般標量 {{ var }}
    out = replaceScalars(out, vars);
    return out;
}
function replaceScalars(tpl, vars) {
    return tpl.replace(/{{\s*(\w+)\s*}}/g, (_m, k) => {
        const v = vars[k];
        return v === undefined || v === null ? '' : safeToString(v);
    });
}
function safeToString(v) {
    if (typeof v === 'string')
        return v;
    if (typeof v === 'number' || typeof v === 'boolean')
        return String(v);
    try {
        return JSON.stringify(v);
    }
    catch {
        return '';
    }
}
function escapeReg(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
//# sourceMappingURL=simpleTemplate.js.map