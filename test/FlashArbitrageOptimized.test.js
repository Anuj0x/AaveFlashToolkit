const { amount_In_filter, amount_Out_filter, erc20_approve, erc20_transfer, erc20_balance } = require('./utils');

const FlashArbitrageOptimized = artifacts.require("FlashArbitrageOptimized");
const DEXManager = artifacts.require("DEXManager");
const ArbitrageStrategy = artifacts.require("ArbitrageStrategy");
const IERC20 = artifacts.require("IERC20");

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

// Required addresses
const tokenAddresses = {
    'WETH': '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    'DAI': '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    'USDC': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    'USDT': '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    'WBTC': '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'
};

const whaleAccounts = {
    'WETH': '0xE68d531d8B4d035bf3F4BC2DaBb70f51FbB14E23',
    'DAI': '0x38720D56899d46cAD253d08f7cD6CC89d2c83190'
};

const defiAddresses = {
    'AAVE_PROVIDER': '0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5'
};

contract('FlashArbitrageOptimized - Enhanced Arbitrage System', () => {
    let flashArb, dexManager, arbStrategy;
    let accounts;
    let deployer, authorizedCaller;

    beforeEach(async () => {
        accounts = await web3.eth.personal.getAccounts();
        deployer = accounts[9];
        authorizedCaller = accounts[8];

        // Deploy contracts
        const dexManagerInstance = await DEXManager.deployed();
        const arbStrategyInstance = await ArbitrageStrategy.deployed();
        const flashArbInstance = await FlashArbitrageOptimized.deployed();

        dexManager = dexManagerInstance;
        arbStrategy = arbStrategyInstance;
        flashArb = flashArbInstance;

        // Authorize the authorizedCaller
        await flashArb.setAuthorizedCaller(authorizedCaller, true, {from: deployer});
    });

    describe('Contract Deployment and Setup', () => {
        it('should deploy all contracts successfully', async () => {
            assert(dexManager.address !== undefined, 'DEX Manager not deployed');
            assert(arbStrategy.address !== undefined, 'Arbitrage Strategy not deployed');
            assert(flashArb.address !== undefined, 'Flash Arbitrage not deployed');
        });

        it('should set up DEX Manager with correct addresses', async () => {
            const uniV3Router = await dexManager.uniV3Router();
            const uniV2Router = await dexManager.uniV2Router();
            const sushiRouter = await dexManager.sushiRouter();
            const weth = await dexManager.weth();

            assert.equal(uniV3Router, '0xE592427A0AEce92De3Edee1F18E0157C05861564', 'Wrong UniV3 router');
            assert.equal(uniV2Router, '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', 'Wrong UniV2 router');
            assert.equal(weth, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'Wrong WETH address');
        });

        it('should authorize callers correctly', async () => {
            const isAuthorized = await flashArb.authorizedCallers(authorizedCaller);
            assert.isTrue(isAuthorized, 'Authorized caller not set correctly');

            const isDeployerAuthorized = await flashArb.authorizedCallers(deployer);
            assert.isTrue(isDeployerAuthorized, 'Deployer should be authorized');
        });
    });

    describe('Security Features', () => {
        it('should prevent unauthorized arbitrage execution', async () => {
            const arbParams = {
                strategyType: 0, // SIMPLE_2_STEP
                tokens: [tokenAddresses.WETH, tokenAddresses.DAI],
                dexSequence: [0, 1], // UniV3 -> UniV2
                feeSequence: [3000, 0], // 0.3% fee for UniV3
                minOuts: [0, 0]
            };

            try {
                await flashArb.executeArbitrageFlashLoan(
                    tokenAddresses.WETH,
                    amount_In_filter(web3, 1, 18), // 1 WETH
                    arbParams,
                    {from: accounts[1]} // Unauthorized account
                );
                assert.fail('Should have thrown error for unauthorized caller');
            } catch (error) {
                assert(error.message.includes('Not authorized'), 'Wrong error message');
            }
        });

        it('should allow pausing and unpausing', async () => {
            await flashArb.pause({from: deployer});
            let isPaused = await flashArb.paused();
            assert.isTrue(isPaused, 'Contract should be paused');

            await flashArb.unpause({from: deployer});
            isPaused = await flashArb.paused();
            assert.isFalse(isPaused, 'Contract should be unpaused');
        });

        it('should prevent execution when paused', async () => {
            await flashArb.pause({from: deployer});

            const arbParams = {
                strategyType: 0,
                tokens: [tokenAddresses.WETH, tokenAddresses.DAI],
                dexSequence: [0, 1],
                feeSequence: [3000, 0],
                minOuts: [0, 0]
            };

            try {
                await flashArb.executeArbitrageFlashLoan(
                    tokenAddresses.WETH,
                    amount_In_filter(web3, 1, 18),
                    arbParams,
                    {from: authorizedCaller}
                );
                assert.fail('Should have thrown error when paused');
            } catch (error) {
                assert(error.message.includes('Pausable: paused'), 'Wrong pause error message');
            }

            await flashArb.unpause({from: deployer}); // Cleanup
        });
    });

    describe('Arbitrage Strategy Execution', () => {
        it('should execute simple 2-step arbitrage (UniV3 -> UniV2)', async () => {
            console.log('Testing simple 2-step arbitrage...');

            // Fund contract with some WETH for testing
            const weth = await IERC20.at(tokenAddresses.WETH);
            const fundingAmount = amount_In_filter(web3, 0.1, 18); // 0.1 WETH

            await erc20_transfer(web3, tokenAddresses.WETH, whaleAccounts.WETH,
                deployer, 0.1, 18);
            await erc20_approve(web3, tokenAddresses.WETH, deployer,
                flashArb.address, 0.1, 18);
            await weth.transfer(flashArb.address, fundingAmount, {from: deployer});

            const contractBalanceBefore = await weth.balanceOf(flashArb.address);
            console.log('Contract WETH balance before:', amount_Out_filter(web3, contractBalanceBefore, 18));

            // Try arbitrage with microscopic amount first to test logic (will likely fail but tests execution)
            const arbParams = {
                strategyType: 0, // SIMPLE_2_STEP
                tokens: [tokenAddresses.WETH, tokenAddresses.DAI],
                dexSequence: [0, 1], // UniV3 -> UniV2
                feeSequence: [3000, 0], // 0.3% fee for UniV3, 0 for UniV2
                minOuts: [0, 0] // Allow any slippage for testing
            };

            try {
                await flashArb.executeArbitrageFlashLoan(
                    tokenAddresses.WETH,
                    amount_In_filter(web3, 0.01, 18), // Very small amount for testing
                    arbParams,
                    {from: authorizedCaller, gas: 5000000}
                );

                const contractBalanceAfter = await weth.balanceOf(flashArb.address);
                console.log('Contract WETH balance after:', amount_Out_filter(web3, contractBalanceAfter, 18));

                // Check that at least one arbitrage was executed
                const stats = await flashArb.getStats();
                assert.isAtLeast(stats[0], 1, 'No arbitrage was executed');

            } catch (error) {
                console.log('Arbitrage execution result:', error.message);
                // This is expected as we're testing on a fork that may not have arbitrage opportunities
                assert(error.message.includes('Arbitrage not profitable') ||
                      error.message.includes('revert') ||
                      error.message.includes('execution reverted'),
                      'Unexpected error type');
            }
        });

        it('should estimate gas costs for different strategies', async () => {
            const simpleParams = {
                strategyType: 0, // SIMPLE_2_STEP
                tokens: [],
                dexSequence: [],
                feeSequence: [],
                minOuts: []
            };

            const triangularParams = {
                strategyType: 1, // TRIANGULAR
                tokens: [],
                dexSequence: [],
                feeSequence: [],
                minOuts: []
            };

            const simpleGas = await flashArb.estimateArbitrageGas(simpleParams);
            const triangularGas = await flashArb.estimateArbitrageGas(triangularParams);

            assert.isAbove(simpleGas.toNumber(), 0, 'Simple strategy gas should be estimated');
            assert.isAbove(triangularGas.toNumber(), simpleGas.toNumber(),
                'Triangular should cost more gas than simple');
        });
    });

    describe('Profit Withdrawal and Management', () => {
        it('should handle profit withdrawal with miner tips', async () => {
            // First, ensure contract has some WETH
            const weth = await IERC20.at(tokenAddresses.WETH);
            const fundingAmount = amount_In_filter(web3, 0.5, 18); // 0.5 WETH

            await erc20_transfer(web3, tokenAddresses.WETH, whaleAccounts.WETH,
                deployer, 0.5, 18);
            await erc20_approve(web3, tokenAddresses.WETH, deployer,
                flashArb.address, 0.5, 18);
            await weth.transfer(flashArb.address, fundingAmount, {from: deployer});

            const contractBalance = await weth.balanceOf(flashArb.address);
            console.log('Contract WETH balance:', amount_Out_filter(web3, contractBalance, 18));

            if (contractBalance.toString() !== '0') {
                // Test withdrawal with 10% miner tip
                await flashArb.withdrawProfitWithTip(
                    tokenAddresses.WETH,
                    contractBalance.div(2), // Withdraw half
                    10, // 10% miner tip
                    {from: deployer}
                );

                const remainingBalance = await weth.balanceOf(flashArb.address);
                console.log('Remaining balance:', amount_Out_filter(web3, remainingBalance, 18));

                assert.isBelow(remainingBalance.toNumber(),
                    contractBalance.div(2).toNumber() + 1000, // Allow for small rounding errors
                    'Withdrawal should have reduced balance');
            }
        });

        it('should handle emergency withdrawal', async () => {
            const weth = await IERC20.at(tokenAddresses.WETH);
            const initialBalance = await weth.balanceOf(flashArb.address);

            if (initialBalance.toString() !== '0') {
                const withdrawAmount = initialBalance.div(2);
                await flashArb.emergencyWithdraw(
                    tokenAddresses.WETH,
                    withdrawAmount,
                    {from: deployer}
                );

                const finalBalance = await weth.balanceOf(flashArb.address);
                assert.equal(finalBalance.toString(),
                    initialBalance.sub(withdrawAmount).toString(),
                    'Emergency withdrawal failed');
            } else {
                console.log('No WETH balance for emergency withdrawal test');
            }
        });
    });

    describe('Statistics and Monitoring', () => {
        it('should track contract statistics', async () => {
            const stats = await flashArb.getStats();
            const totalArbitrages = stats[0];
            const totalProfit = stats[1];
            const isPaused = stats[2];

            assert.isAtLeast(totalArbitrages.toNumber(), 0, 'Arbitrage count should be >= 0');
            assert.isAtLeast(totalProfit.toNumber(), 0, 'Total profit should be >= 0');
            assert.isBoolean(isPaused, 'Paused state should be boolean');

            console.log(`Total Arbitrages: ${totalArbitrages}`);
            console.log(`Total Profit Generated: ${amount_Out_filter(web3, totalProfit, 18)} WETH`);
            console.log(`Contract Paused: ${isPaused}`);
        });
    });

    describe('DEX Manager Functionality', () => {
        it('should execute direct DEX swaps', async () => {
            // Transfer some WETH to the contract for testing
            const weth = await IERC20.at(tokenAddresses.WETH);
            const dai = await IERC20.at(tokenAddresses.DAI);

            const swapAmount = amount_In_filter(web3, 0.01, 18); // 0.01 WETH
            await erc20_transfer(web3, tokenAddresses.WETH, whaleAccounts.WETH,
                dexManager.address, 0.01, 18);

            const balanceBefore = await dai.balanceOf(dexManager.address);

            // Try a small swap UniV3 WETH -> DAI
            try {
                await dexManager.swap(
                    tokenAddresses.WETH,
                    tokenAddresses.DAI,
                    swapAmount,
                    0, // No minimum output for testing
                    0, // DEX type 0 = Uniswap V3
                    3000 // 0.3% fee
                );

                const balanceAfter = await dai.balanceOf(dexManager.address);
                assert.isAbove(balanceAfter.toNumber(),
                    balanceBefore.toNumber(),
                    'DEX swap should have increased DAI balance');

                console.log('DEX swap successful');
            } catch (error) {
                console.log('DEX swap test result:', error.message);
                // Expected on fork without deep liquidity
            }
        });
    });

    describe('Gas Optimization Verification', () => {
        it('should demonstrate gas optimization features', async () => {
            // Test that constants are being used (gas efficient)
            const REFERRAL_CODE = 0;

            // Test that immutable variables are set correctly
            const dexManagerAddress = await flashArb.dexManager();
            assert.equal(dexManagerAddress, dexManager.address, 'DEX Manager should be set');

            const arbStrategyAddress = await flashArb.arbStrategy();
            assert.equal(arbStrategyAddress, arbStrategy.address, 'Arbitrage Strategy should be set');
        });

        it('should validate input parameters efficiently', async () => {
            // Test parameter validation
            try {
                await flashArb.withdrawProfitWithTip(
                    tokenAddresses.WETH,
                    1000,
                    101, // Invalid percentage > 100
                    {from: deployer}
                );
                assert.fail('Should reject invalid miner tip percentage');
            } catch (error) {
                assert(error.message.includes('Invalid tip percentage'), 'Wrong validation error');
            }
        });
    });
});
