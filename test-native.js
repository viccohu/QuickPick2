const nativeBridge = require('./src/native_bridge');
const { CacheManager } = require('./src/cache_manager');

console.log('========================================');
console.log('QuickPick2 性能优化模块测试');
console.log('========================================\n');

console.log('1. Native 模块状态:');
console.log(nativeBridge.getStatus());
console.log();

const cacheManager = new CacheManager();

async function testScanFiles() {
    console.log('2. 测试文件扫描...');
    const testDir = 'C:/'; // Windows 测试目录
    
    try {
        const startTime = Date.now();
        const files = await nativeBridge.scanFiles([testDir], ['.jpg', '.png']);
        const endTime = Date.now();
        
        console.log(`   扫描完成，耗时: ${endTime - startTime}ms`);
        console.log(`   找到文件: ${files.length} 个`);
        if (files.length > 0) {
            console.log(`   示例文件: ${files[0].name}`);
        }
    } catch (e) {
        console.log(`   错误: ${e.message}`);
    }
    console.log();
}

async function testExifRead() {
    console.log('3. 测试 EXIF 读取...');
    const testFiles = [
        'test1.jpg',
        'test2.jpg'
    ];
    
    try {
        const startTime = Date.now();
        const ratings = await nativeBridge.readExifRatings(testFiles);
        const endTime = Date.now();
        
        console.log(`   读取完成，耗时: ${endTime - startTime}ms`);
        console.log(`   结果:`, ratings);
    } catch (e) {
        console.log(`   错误: ${e.message}`);
    }
    console.log();
}

async function testCache() {
    console.log('4. 测试缓存系统...');
    
    cacheManager.ratings.set('test1.jpg', 5);
    cacheManager.ratings.set('test2.jpg', 3);
    
    console.log('   缓存统计:');
    console.log(cacheManager.getStats());
    console.log();
}

async function runTests() {
    await testScanFiles();
    await testExifRead();
    await testCache();
    
    console.log('========================================');
    console.log('测试完成');
    console.log('========================================');
}

runTests().catch(console.error);
