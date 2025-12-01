#!/usr/bin/env node

/**
 * 手動 E2E 測試腳本
 * 模擬票據提交，驗證 VS Code Extension 的拉票→生稿→回填→審批流程
 */

const http = require('http');

const API_BASE = 'http://localhost:3000/api';

function makeRequest(method, path, data = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, API_BASE);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Content-Type': 'application/json',
            },
        };

        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(body);
                    resolve({ status: res.statusCode, data: result });
                } catch (e) {
                    resolve({ status: res.statusCode, data: body });
                }
            });
        });

        req.on('error', reject);
        
        if (data) {
            req.write(JSON.stringify(data));
        }
        req.end();
    });
}

async function main() {
    console.log('🚀 開始 E2E 測試...\n');

    try {
        // 1. 檢查健康狀態
        console.log('1️⃣ 檢查 Orchestrator 狀態');
        const health = await makeRequest('GET', '/health');
        console.log(`   狀態: ${health.data.status}, dry_run: ${health.data.dry_run}`);
        console.log(`   佇列深度: ${health.data.queue_depth}\n`);

        // 2. 提交測試票據
        console.log('2️⃣ 提交測試票據');
        const ticket = {
            type: 'feature',
            title: '測試票據：實作使用者登入功能',
            description: '需要實作完整的使用者登入系統，包括密碼驗證、Session 管理、登入失敗處理等功能。要求支援 email/username 雙重登入方式。',
            priority: 'high',
            labels: ['frontend', 'backend', 'security'],
            metadata: {
                source: 'manual_test',
                timestamp: new Date().toISOString()
            }
        };

        const submitResult = await makeRequest('POST', '/tickets', ticket);
        if (submitResult.status !== 201) {
            throw new Error(`提交失敗: ${submitResult.status} ${JSON.stringify(submitResult.data)}`);
        }
        
        const ticketId = submitResult.data.id;
        console.log(`   ✅ 票據已提交，ID: ${ticketId}\n`);

        // 3. 檢查票據狀態
        console.log('3️⃣ 檢查票據狀態');
        const statusResult = await makeRequest('GET', `/tickets/${ticketId}`);
        console.log(`   狀態: ${statusResult.data.status}`);
        console.log(`   優先級: ${statusResult.data.priority}\n`);

        // 4. 列出可拉取的票據
        console.log('4️⃣ 查看待處理票據');
        const listResult = await makeRequest('GET', '/tickets?status=pending&limit=5');
        console.log(`   待處理票據數量: ${listResult.data.length}`);
        if (listResult.data.length > 0) {
            listResult.data.forEach((t, i) => {
                console.log(`   ${i+1}. [${t.id.slice(0,8)}] ${t.title} (${t.status})`);
            });
        }
        console.log();

        console.log('🎯 測試票據已準備完成！');
        console.log('💡 現在可以使用 VS Code Extension 進行以下操作：');
        console.log('   1. 在 VS Code 中開啟 PO Bot 側邊欄');
        console.log('   2. 點擊 "Refresh Tickets" 查看待處理票據');
        console.log('   3. 選擇票據查看詳細內容');
        console.log('   4. Extension 會自動處理：拉票→生成→回填');
        console.log('   5. 使用 Approve/Reject 按鈕完成審批流程\n');

        console.log('📊 測試要點：');
        console.log('   • 驗證拉票機制（lease API）');
        console.log('   • 確認 Traditional Chinese prompt');
        console.log('   • 檢查生成稿件品質');
        console.log('   • 測試 approve/reject 功能');
        console.log('   • 觀察背景輪詢行為');
        console.log('   • 驗證 audit logging');

    } catch (error) {
        console.error('❌ 測試失敗:', error.message);
        process.exit(1);
    }
}

main().catch(console.error);