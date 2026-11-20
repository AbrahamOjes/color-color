// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";

interface ILinkToken {
    function transferAndCall(address to, uint256 value, bytes calldata data) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IAutomationRegistrar {
    struct RegistrationParams {
        string name;
        bytes encryptedEmail;
        address upkeepContract;
        uint32 gasLimit;
        address adminAddress;
        uint8 triggerType;
        bytes checkData;
        bytes triggerConfig;
        bytes offchainConfig;
        uint96 amount;
    }

    function registerUpkeep(RegistrationParams calldata params) external returns (uint256);
}

/// @notice Register a Chainlink Automation upkeep for ColorColor on Polygon Amoy.
/// Usage:
///   source .env && forge script script/RegisterColorColorUpkeep.s.sol:RegisterColorColorUpkeep \
///     --rpc-url $AMOY_RPC_URL --broadcast -vvvv
contract RegisterColorColorUpkeep is Script {
    // Polygon Amoy addresses
    address constant LINK_TOKEN = 0x0Fd9e8d3aF1aaee056EB9e802c3A762a667b1904;
    // AutomationRegistrar 2.1.0 on Amoy
    address constant AUTOMATION_REGISTRAR = 0x99083A4bb154B0a3EC7a0D1eb40370C892Db4225;
    /// @dev Override per deployment with COLORCOLOR_ADDRESS — this changes on every redeploy.
    address constant COLOR_COLOR_DEFAULT = 0xD6236f2A4C97a20eC487e4682F823cC672008222;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        address colorColor = vm.envOr("COLORCOLOR_ADDRESS", COLOR_COLOR_DEFAULT);
        require(colorColor.code.length > 0, "COLORCOLOR_ADDRESS has no code on this chain");

        uint96 linkAmount = 5 ether; // 5 LINK funding

        console.log("Deployer:", deployer);
        console.log("ColorColor:", colorColor);
        console.log("LINK balance:", ILinkToken(LINK_TOKEN).balanceOf(deployer));

        vm.startBroadcast(deployerPrivateKey);

        IAutomationRegistrar.RegistrationParams memory params = IAutomationRegistrar.RegistrationParams({
            name: "ColorColor Fast Draw",
            encryptedEmail: "",
            upkeepContract: colorColor,
            gasLimit: 2500000,
            adminAddress: deployer,
            triggerType: 0, // Conditional (custom logic)
            checkData: "",
            triggerConfig: "",
            offchainConfig: "",
            amount: linkAmount
        });

        // Registrar 2.1 flow: approve LINK, then call registerUpkeep directly.
        // (transferAndCall would require abi.encodeWithSelector(registerUpkeep.selector, params)
        //  — the missing selector was the prior "encoding error".)
        ILinkToken(LINK_TOKEN).approve(AUTOMATION_REGISTRAR, linkAmount);
        uint256 upkeepId = IAutomationRegistrar(AUTOMATION_REGISTRAR).registerUpkeep(params);
        console.log("registerUpkeep returned upkeepId:", upkeepId);
        require(upkeepId != 0, "Upkeep not auto-approved (pending manual approval)");

        vm.stopBroadcast();
    }
}
