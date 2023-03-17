import {
  ethers_contracts,
  ChainId,
  EVMChainId,
  CHAIN_ID_SOLANA,
  getForeignAssetTerra,
  hexToUint8Array,
  TerraChainId,
  WSOL_DECIMALS,
  tryNativeToHexString,
} from "@certusone/wormhole-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair } from "@solana/web3.js";
import { LCDClient, MnemonicKey } from "@terra-money/terra.js";
import { ethers, Signer } from "ethers";
import { formatUnits } from "ethers/lib/utils";

import { ChainConfigInfo } from "../../packages/relayer-plugin-interface";

import { getScopedLogger, ScopedLogger } from "../helpers/logHelper";
import { getMetaplexData } from "../executor/utils";
import { getEthereumToken } from "../utils/ethereum";
import { getMultipleAccountsRPC } from "../utils/solana";
import { formatNativeDenom } from "../utils/terra";
import { updateWalletBalances } from "./metrics";
import { providersFromChainConfig } from "../utils/providers";
import { wormholeChainIdtoChainName } from "../utils/utils";
import { TokenMonitoringInfo } from "../config";

let _logger: ScopedLogger | undefined;
const logger = () => {
  if (!_logger) _logger = getScopedLogger(["PullBalances"]);
  return _logger;
}

export type WalletBalance = {
  chainId: ChainId;
  balanceAbs: string;
  balanceFormatted?: string;
  currencyName: string;
  currencyAddressNative: string;
  isNative: boolean;
  walletAddress: string;
};

export interface TerraNativeBalances {
  [index: string]: string;
}

export function pullAllEVMBalances(chainConfig: ChainConfigInfo, privateKeys: string[], tokensToMonitor: TokenMonitoringInfo[]): Promise<WalletBalance[]>[] {
  let balancePromises: Promise<WalletBalance[]>[] = [];
  const providers = providersFromChainConfig([chainConfig]);
  // we can assume EVMChainId because we already passed the isEVMChain check
  const provider = providers.evm[chainConfig.chainId as EVMChainId];

  for (const privateKey of privateKeys) {
    balancePromises.push(pullEVMNativeBalance(chainConfig, privateKey, provider));
    pullEVMTokens(privateKey, chainConfig, tokensToMonitor, provider);
  }

  return balancePromises;
}

export async function pullAllSolanaBalances(chainInfo: ChainConfigInfo, privateKeys: string[]): Promise<WalletBalance[]> {
  const balances: WalletBalance[] = [];

  for (const privateKey of privateKeys) {
    const UintPK = Uint8Array.from(JSON.parse(privateKey));
    const [nativeBalances, tokenBalances] = await Promise.all([
      pullSolanaNativeBalance(chainInfo, UintPK),
      pullSolanaTokenBalances(chainInfo, UintPK),
    ]);

    if (nativeBalances) balances.push(...nativeBalances);
    if (tokenBalances) balances.push(...tokenBalances);
  }

  return balances;
};

async function pullTerraBalance(
  lcd: LCDClient,
  walletAddress: string,
  tokenAddress: string,
  chainId: TerraChainId
): Promise<WalletBalance> {
  const tokenInfo: any = await lcd.wasm.contractQuery(tokenAddress, {
    token_info: {},
  });
  const balanceInfo: any = await lcd.wasm.contractQuery(tokenAddress, {
    balance: {
      address: walletAddress,
    },
  });

  if (!tokenInfo) throw new Error('Token info not found');
  if (!balanceInfo) throw new Error('Balance info not found');

  return {
    chainId,
    balanceAbs: balanceInfo?.balance?.toString() || "0",
    balanceFormatted: formatUnits(
      balanceInfo?.balance?.toString() || "0",
      tokenInfo.decimals
    ),
    currencyName: tokenInfo.symbol,
    currencyAddressNative: tokenAddress,
    isNative: false,
    walletAddress: walletAddress,
  };
}

async function pullSolanaTokenBalances(
  chainInfo: ChainConfigInfo,
  privateKey: Uint8Array
): Promise<WalletBalance[]> {
  const keyPair = Keypair.fromSecretKey(privateKey);
  const connection = new Connection(chainInfo.nodeUrl);
  const _logger = getScopedLogger(["pullSolanaTokenBalances"], logger());

  let allAccounts
  try {
    allAccounts = await connection.getParsedTokenAccountsByOwner(
      keyPair.publicKey,
      { programId: TOKEN_PROGRAM_ID },
      "confirmed"
    );
  } catch (error) {
    _logger.error(`Error token balances for public-key: ${keyPair.publicKey}. ${error}`);
    return [];
  }

  const output: WalletBalance[] = [];

  for (const account of allAccounts.value) {
    const mintAddress: string[] = [account.account.data.parsed?.info?.mint];

    if (!mintAddress) {
      _logger.warn(`No mint address found for public-key: ${keyPair.publicKey}. Skipping...`);
      continue;
    }

    try {
      const mdArray = await getMetaplexData(mintAddress, chainInfo);
      let cName: string = "";
      if (mdArray && mdArray[0] && mdArray[0].data && mdArray[0].data.symbol) {
        const encoded = mdArray[0].data.symbol;
        cName = encodeURIComponent(encoded);
        cName = cName.replace(/%/g, "_");
      }

      output.push({
        chainId: CHAIN_ID_SOLANA,
        balanceAbs: account.account.data.parsed?.info?.tokenAmount?.amount,
        balanceFormatted:
          account.account.data.parsed?.info?.tokenAmount?.uiAmount,
        currencyName: cName,
        currencyAddressNative: account.account.data.parsed?.info?.mint,
        isNative: false,
        walletAddress: account.pubkey.toString(),
      });
    } catch (e) {
      _logger.error(`Failed to pull balance for account acount ${mintAddress}. Error: ${e}`);
    }
  }

  _logger.debug(`Got balances: ${JSON.stringify(output)}`);

  return output;
}

async function pullEVMNativeBalance(
  chainInfo: ChainConfigInfo,
  privateKey: string,
  provider: ethers.providers.JsonRpcProvider,
): Promise<WalletBalance[]> {
  const _logger = getScopedLogger(["pullEVMNativeBalance"], logger());

  if (!chainInfo.nativeCurrencySymbol) {
    _logger.error(`Wont pull balance. Missing nativeCurrencySymbol: ${JSON.stringify(chainInfo)}`);
    return [];
  }

  try {
    const signer: Signer = new ethers.Wallet(privateKey, provider);
    const addr: string = await signer.getAddress();
    const weiAmount = await provider.getBalance(addr);
    const balanceInEth = ethers.utils.formatEther(weiAmount);

    const balance = {
      chainId: chainInfo.chainId,
      balanceAbs: weiAmount.toString(),
      balanceFormatted: balanceInEth.toString(),
      currencyName: chainInfo.nativeCurrencySymbol,
      currencyAddressNative: "",
      isNative: true,
      walletAddress: addr,
    };

    _logger.debug(`Got balance: ${JSON.stringify(balance)}`);
    return [balance];
  } catch (e) {
    _logger.error(`Failed to pull balance for config: ${JSON.stringify(chainInfo)}. Error: ${e}`);
    return [];
  }
}

async function pullTerraNativeBalance(
  lcd: LCDClient,
  chainInfo: ChainConfigInfo,
  walletAddress: string
): Promise<WalletBalance[]> {
  const output: WalletBalance[] = [];
  const [coins] = await lcd.bank.balance(walletAddress);
  // coins doesn't support reduce
  const balancePairs = coins.map(({ amount, denom }) => [denom, amount]);
  const balance = balancePairs.reduce((obj, current) => {
    obj[current[0].toString()] = current[1].toString();
    return obj;
  }, {} as TerraNativeBalances);
  Object.keys(balance).forEach((key) => {
    output.push({
      chainId: chainInfo.chainId,
      balanceAbs: balance[key],
      balanceFormatted: formatUnits(balance[key], 6).toString(),
      currencyName: formatNativeDenom(key, chainInfo.chainId as TerraChainId),
      currencyAddressNative: key,
      isNative: true,
      walletAddress: walletAddress,
    });
  });
  return output;
}

async function pullSolanaNativeBalance(
  chainInfo: ChainConfigInfo,
  privateKey: Uint8Array
): Promise<WalletBalance[]> {
  const _logger = getScopedLogger(["pullSolanaNativeBalance"], logger());

  if (!chainInfo.nativeCurrencySymbol) {
    _logger.error(`Wont pull balance, missing nativeCurrencySymbol ${JSON.stringify(chainInfo)}`);
    return [];
  }

  const keyPair = Keypair.fromSecretKey(privateKey);
  const connection = new Connection(chainInfo.nodeUrl);

  let fetchAccounts;
  try {
    fetchAccounts = await getMultipleAccountsRPC(connection, [
      keyPair.publicKey,
    ]);
  } catch (error) {
    _logger.error(`Error fetching Account. ${error}`);
    return []
  }

  if (!fetchAccounts[0]) {
    //Accounts with zero balance report as not existing.
    _logger.debug("Account does not exist, returning zero balance");
    return [
      {
        chainId: chainInfo.chainId,
        balanceAbs: "0",
        balanceFormatted: "0",
        currencyName: chainInfo.nativeCurrencySymbol,
        currencyAddressNative: chainInfo.chainName,
        isNative: true,
        walletAddress: keyPair.publicKey.toString(),
      },
    ];
  }

  const amountLamports = fetchAccounts[0].lamports.toString();
  const amountSol = formatUnits(
    fetchAccounts[0].lamports,
    WSOL_DECIMALS
  ).toString();

  const balance = [
    {
      chainId: chainInfo.chainId,
      balanceAbs: amountLamports,
      balanceFormatted: amountSol,
      currencyName: chainInfo.nativeCurrencySymbol,
      currencyAddressNative: "",
      isNative: true,
      walletAddress: keyPair.publicKey.toString(),
    },
  ];

  _logger.debug(`Got balance: ${JSON.stringify(balance)}`);

  return balance;
}

async function calcLocalAddressesEVM(
  provider: ethers.providers.Provider,
  tokensToMonitor: TokenMonitoringInfo[],
  chainId: ChainId,
  tokenBridgeAddress: string,
): Promise<string[]> {
  const _logger = getScopedLogger(["calcLocalAddressesEVM"], logger());

  const tokenBridge = ethers_contracts.Bridge__factory.connect(tokenBridgeAddress, provider);

  const tokenAddresses: string[] = await Promise.all(tokensToMonitor.map(async (token) => {
    if (token.chainId === chainId) return token.address;

    let hexAddress: string;

    try {
      hexAddress = tryNativeToHexString(token.address, wormholeChainIdtoChainName(chainId));
    } catch (error) {
      _logger.error(`Failed to convert address ${token.address} to hex. Error: ${error}`);
      return '';
    }

    let localAddress: string;
    try {
      localAddress = await tokenBridge.wrappedAsset(token.chainId, hexToUint8Array(hexAddress));
    } catch (error) {
      _logger.error(`Failed to get local address for token ${token.address} on chain ${chainId}. Error: ${error}`);
      return '';
    }

    return localAddress;
  }));

  const retVal = tokenAddresses.filter(
    (tokenAddress: string | null) =>
      tokenAddress && tokenAddress !== ethers.constants.AddressZero
  );

  _logger.debug(`Local addresses for chain ${chainId}: ${retVal.join(', ')}`);

  return retVal;
}

async function calcLocalAddressesTerra(
  lcd: LCDClient,
  tokensToMonitor: TokenMonitoringInfo[],
  chainId: ChainId,
  tokenBridgeAddress: string,
) {
  const _logger = getScopedLogger(["calcLocalAddressesTerra"], logger());

  const output: string[] = [];
  for (const token of tokensToMonitor) {
    if (token.chainId === chainId) {
      if (token.address.startsWith("terra")) {
        _logger.debug(`${token.address} is a native token`);
        output.push(token.address);
      }
      continue;
    }

    let hexAddress;
    try {
      hexAddress = tryNativeToHexString(
        token.address,
        wormholeChainIdtoChainName(token.chainId),
      );
    } catch (error) {
      _logger.error(`Failed to convert address ${token.address} to hex. Error: ${error}`);
      continue;
    }

    let foreignAddress;
    try {
      foreignAddress = await getForeignAssetTerra(
        tokenBridgeAddress,
        lcd,
        token.chainId,
        hexToUint8Array(hexAddress)
      );
    } catch (e) {
      _logger.error(`Failed to get Terra foreign address for token ${token.address}. Error: ${e}`);
    }

    if (!foreignAddress) continue;

    output.push(foreignAddress);
  }

  _logger.debug(`Local addresses found for chain ${chainId}: ${output.join(', ')}`);
  return output;
}

async function pullEVMTokens(
  privateKey: string,
  chainConfig: ChainConfigInfo,
  tokensToMonitor: TokenMonitoringInfo[],
  provider: ethers.providers.JsonRpcProvider,
) {
  const _logger = getScopedLogger(["pullEVMTokens"], logger());

  if (tokensToMonitor.length === 0) {
    _logger.verbose(`No tokens to monitor for chain ${chainConfig.chainId}!`);
    return [];
  }

  if (!chainConfig.tokenBridgeAddress) {
    _logger.error(`Wont pull EVM tokens, missing tokenBridgeAddress ${JSON.stringify(chainConfig)}`);
    return [];
  }

  const tokenBridgeAddress = chainConfig.tokenBridgeAddress!;

  const localAddresses = await calcLocalAddressesEVM(
    provider,
    tokensToMonitor,
    chainConfig.chainId,
    tokenBridgeAddress,
  );

  if (!localAddresses.length) {
    _logger.debug(`No local addresses found for chain ${chainConfig.chainId}!`);
    return [];
  }

  let publicAddress: string;
  try {
    publicAddress = await new ethers.Wallet(privateKey).getAddress();
  } catch (error) {
    _logger.error("Failed to get public address", error);
    return [];
  }

  localAddresses.forEach(async (tokenAddress) => {
    try {
      const token = await getEthereumToken(tokenAddress, provider);
      const [decimals, balanceValue, symbol] = await Promise.all([
        token.decimals(),
        token.balanceOf(publicAddress),
        token.symbol()
      ]);

      const balance = {
        chainId: chainConfig.chainId,
        balanceAbs: balanceValue.toString(),
        balanceFormatted: formatUnits(balanceValue, decimals),
        currencyName: symbol,
        currencyAddressNative: tokenAddress,
        isNative: false,
        walletAddress: publicAddress,
      };

      _logger.debug(`Updating Token Balance: ${JSON.stringify(balance)}`);

      updateWalletBalances([balance]);
    } catch (error) {
      _logger.error(`Failed to get balance for token ${tokenAddress} on chain ${chainConfig.chainId}. ${error}`);
    }
  });
}

export async function pullAllTerraBalances(
  chainConfig: ChainConfigInfo,
  privateKeys: string[],
  tokensToMonitor: TokenMonitoringInfo[],
) {
  const _logger = getScopedLogger(["pullAllTerraBalances"], logger());
  if (
    !(
      chainConfig.terraChainId &&
      chainConfig.terraCoin &&
      chainConfig.terraGasPriceUrl &&
      chainConfig.terraName
    )
  ) {
    _logger.error(`Invalid Config for Terra Chain: ${JSON.stringify(chainConfig)}`);
    return [];
  }

  const lcdConfig = {
    URL: chainConfig.nodeUrl,
    chainID: chainConfig.terraChainId,
    name: chainConfig.terraName,
    isClassic: chainConfig.isTerraClassic,
  };
  const lcd = new LCDClient(lcdConfig);

  if (!chainConfig.tokenBridgeAddress) {
    _logger.error(`Wont pull Terra tokens for chainId ${chainConfig.chainId}, missing tokenBridgeAddress`);
    return [];
  }

  const localAddresses = await calcLocalAddressesTerra(
    lcd,
    tokensToMonitor,
    chainConfig.chainId,
    chainConfig.tokenBridgeAddress!,
  );

  for (const privateKey of privateKeys) {
    const mk = new MnemonicKey({ mnemonic: privateKey });
    const wallet = lcd.wallet(mk);
    const walletAddress = wallet.key.accAddress;

    _logger.debug("Pulling Terra balances for %s", walletAddress);

    try {
      const nativeBalances = await pullTerraNativeBalance(lcd, chainConfig, walletAddress);
      _logger.debug(`Got balance for ${walletAddress}: ${JSON.stringify(nativeBalances)}`);
      updateWalletBalances(nativeBalances);
    } catch (error) {
      _logger.error(`Failed to pull balances for address: ${walletAddress}. Error: ${error}`);
    }

    // Forcing the map and promise.all to avoid running in parallel for many private keys
    // as a way to handle concurrency in order to avoid collapsing the node
    // not sure if this makes sense when interacting with a blockchain
    await Promise.all(localAddresses.map(async (address) => {
      try {
        const balance = await pullTerraBalance(
          lcd,
          walletAddress,
          address,
          chainConfig.chainId as TerraChainId,
        );

        _logger.debug(`Got balance for ${address}: ${JSON.stringify(balance)}`);
        updateWalletBalances([balance]);
      } catch (error) {
        _logger.error(`Failed to pull terra balance for walletAddress ${walletAddress}. Error: ${error}`);
      }
    }));
  }
}
