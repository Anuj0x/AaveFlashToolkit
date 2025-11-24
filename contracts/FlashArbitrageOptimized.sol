// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title FlashArbitrageOptimized
 * @dev Optimized flash loan arbitrage contract with modular architecture,
 * gas optimizations, and advanced features
 * @author Optimized version of Flash_Loans_V3
 */

// Interfaces
interface IWETH9 {
    function withdraw(uint wad) external;
    function deposit() external payable;
}

interface ILendingPool {
    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata modes,
        address onBehalfOf,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface ILendingPoolAddressesProvider {
    function getLendingPool() external view returns (address);
}

interface IFlashLoanReceiver {
    function executeOperation(
        address[] calldata assets,
        uint[] calldata amounts,
        uint[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

// Uniswap V3 interfaces for optimized swaps
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

// Uniswap V2 interface
interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);

    function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts);
}

// SushiSwap interface
interface ISushiSwapRouter is IUniswapV2Router {}

/**
 * @dev Base contract for flash loan receivers
 */
abstract contract FlashLoanReceiverBaseV2 is IFlashLoanReceiver {
    ILendingPoolAddressesProvider public immutable ADDRESSES_PROVIDER;
    ILendingPool public immutable LENDING_POOL;

    constructor(address provider) {
        ADDRESSES_PROVIDER = ILendingPoolAddressesProvider(provider);
        LENDING_POOL = ILendingPool(ILendingPoolAddressesProvider(provider).getLendingPool());
    }

    receive() external virtual payable {}
}

/**
 * @dev DEX abstraction layer for modular routing
 */
contract DEXManager {
    using SafeERC20 for IERC20;

    // DEX addresses - immutable for gas savings
    ISwapRouter public immutable uniV3Router;
    IUniswapV2Router public immutable uniV2Router;
    ISushiSwapRouter public immutable sushiRouter;
    IWETH9 public immutable weth;

    // Fee tiers for Uniswap V3
    uint24 private constant FEE_LOW = 500;      // 0.05%
    uint24 private constant FEE_MEDIUM = 3000;  // 0.3%
    uint24 private constant FEE_HIGH = 10000;   // 1%

    constructor(
        address _uniV3Router,
        address _uniV2Router,
        address _sushiRouter,
        address _weth
    ) {
        uniV3Router = ISwapRouter(_uniV3Router);
        uniV2Router = IUniswapV2Router(_uniV2Router);
        sushiRouter = ISushiSwapRouter(_sushiRouter);
        weth = IWETH9(_weth);
    }

    /**
     * @dev Execute swap on specified DEX
     */
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint8 dexType,
        uint24 fee
    ) external returns (uint256 amountOut) {
        if (dexType == 0) { // Uniswap V3
            return _swapUniV3(tokenIn, tokenOut, amountIn, amountOutMin, fee);
        } else if (dexType == 1) { // Uniswap V2
            return _swapUniV2(tokenIn, tokenOut, amountIn, amountOutMin);
        } else if (dexType == 2) { // SushiSwap
            return _swapSushi(tokenIn, tokenOut, amountIn, amountOutMin);
        }
        revert("Invalid DEX type");
    }

    function _swapUniV3(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint24 fee
    ) private returns (uint256 amountOut) {
        IERC20(tokenIn).safeApprove(address(uniV3Router), amountIn);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: address(this),
            deadline: block.timestamp + 300,
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0
        });

        return uniV3Router.exactInputSingle(params);
    }

    function _swapUniV2(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin
    ) private returns (uint256 amountOut) {
        IERC20(tokenIn).safeApprove(address(uniV2Router), amountIn);
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint[] memory amounts = uniV2Router.swapExactTokensForTokens(
            amountIn, amountOutMin, path, address(this), block.timestamp + 300
        );
        return amounts[1];
    }

    function _swapSushi(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin
    ) private returns (uint256 amountOut) {
        IERC20(tokenIn).safeApprove(address(sushiRouter), amountIn);
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint[] memory amounts = sushiRouter.swapExactTokensForTokens(
            amountIn, amountOutMin, path, address(this), block.timestamp + 300
        );
        return amounts[1];
    }
}

/**
 * @dev Arbitrage strategy abstraction
 */
contract ArbitrageStrategy {
    DEXManager public dexManager;

    enum StrategyType {
        SIMPLE_2_STEP,      // A->B, B->A on different DEXes
        TRIANGULAR,         // A->B->C->A across DEXes
        MULTI_HOP           // Complex multi-hop paths
    }

    struct ArbitrageParams {
        StrategyType strategyType;
        address[] tokens;
        uint8[] dexSequence;     // DEX types for each hop
        uint24[] feeSequence;    // Fee tiers for each hop
        uint256[] minOuts;       // Minimum output for each hop
    }

    constructor(address _dexManager) {
        dexManager = DEXManager(_dexManager);
    }

    /**
     * @dev Execute arbitrage strategy
     */
    function executeStrategy(
        ArbitrageParams memory params,
        uint256 amountIn
    ) external returns (uint256 finalAmount) {
        uint256 currentAmount = amountIn;

        if (params.strategyType == StrategyType.SIMPLE_2_STEP) {
            // First hop
            currentAmount = dexManager.swap(
                params.tokens[0], params.tokens[1], currentAmount,
                params.minOuts[0], params.dexSequence[0], params.feeSequence[0]
            );

            // Second hop - back to original token
            finalAmount = dexManager.swap(
                params.tokens[1], params.tokens[0], currentAmount,
                params.minOuts[1], params.dexSequence[1], params.feeSequence[1]
            );

        } else if (params.strategyType == StrategyType.TRIANGULAR) {
            // A -> B -> C -> A
            currentAmount = dexManager.swap(
                params.tokens[0], params.tokens[1], currentAmount,
                params.minOuts[0], params.dexSequence[0], params.feeSequence[0]
            );

            currentAmount = dexManager.swap(
                params.tokens[1], params.tokens[2], currentAmount,
                params.minOuts[1], params.dexSequence[1], params.feeSequence[1]
            );

            finalAmount = dexManager.swap(
                params.tokens[2], params.tokens[0], currentAmount,
                params.minOuts[2], params.dexSequence[2], params.feeSequence[2]
            );
        }

        require(finalAmount > amountIn, "Arbitrage not profitable");
        return finalAmount;
    }
}

/**
 * @dev Main flash arbitrage contract
 */
contract FlashArbitrageOptimized is
    FlashLoanReceiverBaseV2,
    Ownable,
    ReentrancyGuard,
    Pausable
{
    using SafeERC20 for IERC20;

    // Libraries and contracts
    DEXManager public dexManager;
    ArbitrageStrategy public arbStrategy;

    // Events
    event ArbitrageExecuted(address indexed asset, uint256 amountBorrowed, uint256 profit, uint256 gasUsed);
    event StrategyUpdated(address indexed newStrategy);
    event ProfitWithdrawn(address indexed token, uint256 amount, address indexed recipient);
    event EmergencyWithdrawn(address indexed token, uint256 amount);

    // State variables
    mapping(address => bool) public authorizedCallers;
    uint256 public totalArbitragesExecuted;
    uint256 public totalProfitGenerated;

    // Constants for gas optimization
    uint16 private constant REFERRAL_CODE = 0;
    uint256 private constant DEADLINE = 300; // 5 minutes

    modifier onlyAuthorized() {
        require(authorizedCallers[msg.sender] || msg.sender == owner(), "Not authorized");
        _;
    }

    constructor(
        address _addressProvider,
        address _dexManager,
        address _arbStrategy
    ) FlashLoanReceiverBaseV2(_addressProvider) {
        dexManager = DEXManager(_dexManager);
        arbStrategy = ArbitrageStrategy(_arbStrategy);
        authorizedCallers[msg.sender] = true;
    }

    /**
     * @dev Execute flash loan arbitrage
     */
    function executeArbitrageFlashLoan(
        address asset,
        uint256 amount,
        ArbitrageStrategy.ArbitrageParams calldata arbParams
    ) external onlyAuthorized whenNotPaused nonReentrant {
        uint256 gasStart = gasleft();

        address[] memory assets = new address[](1);
        assets[0] = asset;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        uint256[] memory modes = new uint256[](1);
        modes[0] = 0; // flash loan mode

        bytes memory params = abi.encode(arbParams);

        LENDING_POOL.flashLoan(
            address(this),
            assets,
            amounts,
            modes,
            address(this),
            params,
            REFERRAL_CODE
        );

        uint256 gasUsed = gasStart - gasleft();
        emit ArbitrageExecuted(asset, amount, 0, gasUsed); // Profit calculated in executeOperation
        totalArbitragesExecuted++;
    }

    /**
     * @dev Flash loan callback - execute arbitrage logic
     */
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address calldata initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(LENDING_POOL), "Invalid caller");
        require(initiator == address(this), "Invalid initiator");

        ArbitrageStrategy.ArbitrageParams memory arbParams = abi.decode(params, (ArbitrageStrategy.ArbitrageParams));
        address asset = assets[0];
        uint256 amount = amounts[0];

        // Execute arbitrage strategy
        uint256 finalAmount = arbStrategy.executeStrategy(arbParams, amount);
        uint256 profit = finalAmount - amount;

        // Update total profit
        totalProfitGenerated += profit;

        // Emit actual profit
        emit ArbitrageExecuted(asset, amount, profit, 0);

        // Ensure we have enough to repay flash loan
        uint256 amountOwing = amount + premiums[0];
        require(finalAmount >= amountOwing, "Insufficient funds to repay flash loan");

        // Approve repayment
        IERC20(asset).safeApprove(address(LENDING_POOL), amountOwing);

        return true;
    }

    /**
     * @dev Withdraw profits with miner tip
     */
    function withdrawProfitWithTip(
        address token,
        uint256 amount,
        uint8 minerTipPercent
    ) external onlyOwner {
        require(minerTipPercent <= 100, "Invalid tip percentage");

        uint256 contractBalance = IERC20(token).balanceOf(address(this));
        require(amount <= contractBalance, "Insufficient balance");

        // Calculate tip for miner
        uint256 tipAmount = (amount * minerTipPercent) / 100;

        // Send tip to miner (block.coinbase)
        if (token == address(dexManager.weth())) {
            dexManager.weth().withdraw(tipAmount);
            payable(block.coinbase).transfer(tipAmount);
            amount -= tipAmount;
        }
        // For other tokens, convert to WETH first and tip
        else if (minerTipPercent > 0) {
            // Swap token to WETH for miner tip
            uint256 wethReceived = dexManager.swap(token, address(dexManager.weth()), tipAmount, 0, 1, 0); // Use UniV2 for conversion
            dexManager.weth().withdraw(wethReceived);
            payable(block.coinbase).transfer(wethReceived);
            amount -= tipAmount - wethReceived; // Adjust for slippage
        }

        // Send remaining profit to owner
        IERC20(token).safeTransfer(owner(), amount);
        emit ProfitWithdrawn(token, amount, owner());
    }

    /**
     * @dev Emergency withdrawal function
     */
    function emergencyWithdraw(
        address token,
        uint256 amount
    ) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 withdrawAmount = amount > balance ? balance : amount;

        IERC20(token).safeTransfer(owner(), withdrawAmount);
        emit EmergencyWithdrawn(token, withdrawAmount);
    }

    /**
     * @dev Update arbitrage strategy contract
     */
    function updateArbitrageStrategy(address newStrategy) external onlyOwner {
        arbStrategy = ArbitrageStrategy(newStrategy);
        emit StrategyUpdated(newStrategy);
    }

    /**
     * @dev Authorize/deauthorize callers
     */
    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        authorizedCallers[caller] = authorized;
    }

    /**
     * @dev Pause/unpause contract
     */
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Get contract statistics
     */
    function getStats() external view returns (
        uint256 totalArbitrages,
        uint256 totalProfit,
        bool paused
    ) {
        return (totalArbitragesExecuted, totalProfitGenerated, paused());
    }

    /**
     * @dev Estimate gas cost for arbitrage
     */
    function estimateArbitrageGas(
        ArbitrageStrategy.ArbitrageParams memory params
    ) external view returns (uint256 estimatedGas) {
        // Gas estimation logic would go here
        // Simplified for demonstration
        if (params.strategyType == ArbitrageStrategy.StrategyType.SIMPLE_2_STEP) {
            return 250000; // Base gas for 2-step arbitrage
        } else if (params.strategyType == ArbitrageStrategy.StrategyType.TRIANGULAR) {
            return 350000; // Base gas for triangular arbitrage
        }
        return 200000; // Default
    }

    // Receive function for WETH unwrapping
    receive() external override payable {}
}
