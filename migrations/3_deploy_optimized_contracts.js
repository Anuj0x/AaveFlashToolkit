const FlashArbitrageOptimized = artifacts.require("FlashArbitrageOptimized");
const DEXManager = artifacts.require("DEXManager");
const ArbitrageStrategy = artifacts.require("ArbitrageStrategy");

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

module.exports = async function (deployer, network) {
    try {
        // DEX Router addresses
        const DEX_ADDRESSES = {
            uniV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Uniswap V3 SwapRouter
            uniV2Router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2 Router02
            sushiRouter: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F', // SushiSwap Router
            weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',     // WETH
            aaveProvider: '0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5' // Aave Lending Pool Provider
        };

        console.log('Deploying DEX Manager...');
        await deployer.deploy(
            DEXManager,
            DEX_ADDRESSES.uniV3Router,
            DEX_ADDRESSES.uniV2Router,
            DEX_ADDRESSES.sushiRouter,
            DEX_ADDRESSES.weth
        );
        const dexManager = await DEXManager.deployed();

        console.log('Deploying Arbitrage Strategy...');
        await deployer.deploy(ArbitrageStrategy, dexManager.address);
        const arbStrategy = await ArbitrageStrategy.deployed();

        console.log('Deploying Flash Arbitrage Optimized...');
        await deployer.deploy(
            FlashArbitrageOptimized,
            DEX_ADDRESSES.aaveProvider,
            dexManager.address,
            arbStrategy.address
        );
        const flashArbOptimized = await FlashArbitrageOptimized.deployed();

        console.log('Deployment Summary:');
        console.log('===================');
        console.log(`DEX Manager: ${dexManager.address}`);
        console.log(`Arbitrage Strategy: ${arbStrategy.address}`);
        console.log(`Flash Arbitrage Optimized: ${flashArbOptimized.address}`);

    } catch (e) {
        console.log(`Error in migration: ${e.message}`);
        console.log('Stack trace:', e.stack);
    }
}
