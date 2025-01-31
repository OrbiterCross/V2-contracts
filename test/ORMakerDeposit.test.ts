import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { assert, expect } from 'chai';
import { BigNumber, BigNumberish, Wallet, constants, utils } from 'ethers';
import { ethers } from 'hardhat';
import fs from 'fs';

import {
  BytesLike,
  RLP,
  arrayify,
  defaultAbiCoder,
  keccak256,
  solidityPack,
} from 'ethers/lib/utils';
import lodash, { get, random } from 'lodash';
import { BaseTrie } from 'merkle-patricia-tree';
import {
  OREventBinding,
  OREventBinding__factory,
  ORMDCFactory,
  ORMDCFactory__factory,
  ORMakerDeposit,
  ORMakerDeposit__factory,
  ORManager,
  ORManager__factory,
  TestSpv,
  TestSpv__factory,
  TestToken,
  TestToken__factory,
  ORChallengeSpvMainnet,
  ORChallengeSpvMainnet__factory,
  TestMakerDeposit,
  TestMakerDeposit__factory,
  RLPDecoder,
  RLPDecoder__factory,
  ORSpvData__factory,
  ORChallengeSpvEra,
  ORChallengeSpvEra__factory,
} from '../typechain-types';
import { defaultChainInfo } from './defaults';
import {
  RuleStruct,
  calculateRuleKey,
  calculateRulesTree,
  converRule,
  createMakerRule,
  createRandomRule,
  encodeChallengeRawData,
  formatRule,
  getRulesRootUpdatedLogs,
} from './lib/rule';
import {
  challengeInputInfo,
  columnArray,
  embedVersionIncreaseAndEnableTime,
  getEffectiveEbcsFromLogs,
  getMinEnableTime,
  hexToBuffer,
  testReverted,
  testRevertedOwner,
  createChallenge,
  getSecurityCode,
  getVerifyinfo,
  updateSpv,
  VerifyinfoBase,
  calculateTxGas,
  challengeManager,
  liquidateChallenge,
  PublicInputData,
  updateMakerRule,
  PublicInputDataDest,
  VerifiedDataInfo,
  getRLPEncodeMakerRuleHash,
  getRawDataNew,
  mockSpvData,
} from './utils.test';
import {
  callDataCost,
  chainIdsMock,
  dealersMock,
  defaultChainInfoArray,
  defaultResponseTime,
  getCurrentTime,
  mineXTimes,
} from './lib/mockData';
import { PromiseOrValue } from '../typechain-types/common';
import { randomBytes } from 'crypto';
import {
  compile_yul,
  createRandomChallenge,
  deployContracts,
  deployMDC,
  deploySPVs,
  getSpvProof,
  SPVTypeEnum,
  VerifierAbi,
} from '../scripts/utils';
import { Console } from 'console';

describe('ORMakerDeposit', () => {
  let signers: SignerWithAddress[];
  let mdcOwner: SignerWithAddress;
  let orManager: ORManager;
  let orManagerEbcs: string[];
  let ebcs: string[];
  let orMDCFactory: ORMDCFactory;
  let orMakerDeposit: ORMakerDeposit;
  let implementation: string;
  let testToken: TestToken;
  let columnArray: columnArray;
  let ebc: OREventBinding;

  before(async function () {
    signers = await ethers.getSigners();
    mdcOwner = signers[1];

    const envORMDCFactoryAddress = process.env['OR_MDC_FACTORY_ADDRESS'];
    assert(
      !!envORMDCFactoryAddress,
      'Env miss [OR_MDC_FACTORY_ADDRESS]. You may need to test ORMDCFactory.test.ts first. Example: npx hardhat test test/ORManager.test test/ORFeeManager.test.ts test/ORMDCFactory.test.ts test/ORMakerDeposit.test.ts',
    );

    orMDCFactory = new ORMDCFactory__factory(signers[0]).attach(
      envORMDCFactoryAddress,
    );
    implementation = await orMDCFactory.implementation();

    orManager = new ORManager__factory(signers[0]).attach(
      await orMDCFactory.manager(),
    );

    if (process.env['EVENT_BINDING_CONTRACT'] != undefined) {
      ebc = OREventBinding__factory.connect(
        process.env['EVENT_BINDING_CONTRACT'],
        signers[0],
      );
      console.log('connect to ebc contract', ebc.address);
    } else {
      ebc = await new OREventBinding__factory(signers[0]).deploy();
      process.env['EVENT_BINDING_CONTRACT'] = ebc.address;
      console.log('Address of ebc:', ebc.address);
    }

    orManagerEbcs = [ebc.address].concat(
      await getEffectiveEbcsFromLogs(orManager),
    );

    const envTestTokenAddress = process.env['TEST_TOKEN_ADDRESS'];

    if (envTestTokenAddress) {
      testToken = new TestToken__factory(mdcOwner).attach(envTestTokenAddress);
      console.log('connect of testToken:', testToken.address);
    } else {
      testToken = await new TestToken__factory(mdcOwner).deploy(
        'TestToken',
        'OTT',
      );
      console.log('Address of testToken:', testToken.address);
      process.env['TEST_TOKEN_ADDRESS'] = testToken.address;
    }
    await testToken.deployed();

    ebcs = lodash.cloneDeep(orManagerEbcs);
    await mineXTimes(60);
  });

  it('Restoring the ORMakerDeposit should succeed', async function () {
    const predictMDCAddress = await orMDCFactory
      .connect(mdcOwner)
      .predictMDCAddress();
    orMakerDeposit = new ORMakerDeposit__factory(mdcOwner).attach(
      predictMDCAddress,
    );
    console.log('connect of mdc:', orMakerDeposit.address);
    const owner = await orMakerDeposit.owner();

    expect(owner).eq(mdcOwner.address);
  });

  it("ORMakerDeposit's functions prefixed with _ should be private", async function () {
    for (const key in orMakerDeposit.functions) {
      expect(key.replace(/^_/, '')).eq(key);
    }
  });

  it(
    'Function updateColumnArray should emit events and update hash',
    embedVersionIncreaseAndEnableTime(
      () => orMakerDeposit.getVersionAndEnableTime().then((r) => r.version),
      async function () {
        const mdcEbcs: string[] = ebcs.slice(0, 8);
        if (process.env['EVENT_BINDING_CONTRACT'] != undefined) {
          mdcEbcs.push(process.env['EVENT_BINDING_CONTRACT']);
        } else {
          mdcEbcs.push(ebc.address);
        }
        mdcEbcs.sort(() => Math.random() - 0.5);

        const mdcDealers: string[] = await dealersMock();
        const chainIds: number[] = chainIdsMock;
        const columnArrayHash = utils.keccak256(
          utils.defaultAbiCoder.encode(
            ['uint256[]', 'uint256[]', 'uint256[]'],
            [mdcDealers, mdcEbcs, chainIds],
          ),
        );
        columnArray = {
          dealers: mdcDealers,
          ebcs: mdcEbcs,
          chainIds: chainIds,
        };
        console.log(
          `columnArray:${columnArray}, columnHash: ${columnArrayHash}`,
        );

        const { events } = await orMakerDeposit
          .updateColumnArray(
            getMinEnableTime(BigNumber.from(await getCurrentTime())),
            mdcDealers,
            mdcEbcs,
            chainIds,
            {
              gasLimit: 10000000,
            },
          )
          .then((t) => t.wait());

        const args = events?.[0].args;
        expect(args?.impl).eq(implementation);
        expect(await orMakerDeposit.columnArrayHash()).eq(columnArrayHash);
        expect(lodash.toPlainObject(args?.ebcs)).to.deep.includes(mdcEbcs);
        expect(lodash.toPlainObject(args?.dealers)).to.deep.includes(
          mdcDealers,
        );

        await testRevertedOwner(
          orMakerDeposit
            .connect(signers[2])
            .updateColumnArray(
              getMinEnableTime(
                (
                  await orMakerDeposit.getVersionAndEnableTime()
                ).enableTime,
              ),
              [],
              mdcEbcs,
              [],
            ),
        );

        await expect(
          orMakerDeposit.updateColumnArray(
            (
              await orMakerDeposit.getVersionAndEnableTime()
            ).enableTime,
            mdcDealers,
            mdcEbcs,
            chainIds,
            {
              gasLimit: 10000000,
            },
          ),
        ).to.revertedWith('OFET');

        await expect(
          orMakerDeposit.updateColumnArray(
            getMinEnableTime(
              (
                await orMakerDeposit.getVersionAndEnableTime()
              ).enableTime,
            ).add(10000000),
            mdcDealers,
            mdcEbcs,
            chainIds,
            {
              gasLimit: 10000000,
            },
          ),
        ).to.revertedWith('OFET');
      },
    ),
  );

  it(
    'Function updateSpvs should emit events and update storage',
    embedVersionIncreaseAndEnableTime(
      () => orMakerDeposit.getVersionAndEnableTime().then((r) => r.version),
      async function () {
        const chainId = defaultChainInfo.id;
        const chainInfo = await orManager.getChainInfo(chainId);

        const spvs = chainInfo.spvs.slice(0, 1);
        const chainIds = [chainId];
        console.log(
          `maker update[chainId: ${chainIds.toString()} - spv: ${spvs}]`,
        );

        const { events } = await orMakerDeposit
          .updateSpvs(
            getMinEnableTime(
              (
                await orMakerDeposit.getVersionAndEnableTime()
              ).enableTime,
            ),
            spvs,
            chainIds,
          )
          .then((t) => t.wait());

        events?.forEach((event, index) => {
          expect(event.args?.['impl']).eq(implementation);
          expect(event.args?.['chainId']).eq(chainIds[index]);
          expect(event.args?.['spv']).eq(spvs[index]);
        });

        // eslint-disable-next-line @typescript-eslint/no-for-in-array
        for (const i in chainIds) {
          const spv = await orMakerDeposit.spv(chainIds[i]);
          expect(spv).eq(spvs[i]);
        }

        await testRevertedOwner(
          orMakerDeposit
            .connect(signers[2])
            .updateSpvs(
              getMinEnableTime(
                (
                  await orMakerDeposit.getVersionAndEnableTime()
                ).enableTime,
              ),
              spvs,
              chainIds,
            ),
        );

        await testReverted(
          orMakerDeposit.updateSpvs(
            getMinEnableTime(
              (
                await orMakerDeposit.getVersionAndEnableTime()
              ).enableTime,
            ),
            spvs,
            [2 ** 16 - 1],
          ),
          'CI',
        );
        await testReverted(
          orMakerDeposit.updateSpvs(
            getMinEnableTime(
              (
                await orMakerDeposit.getVersionAndEnableTime()
              ).enableTime,
            ),
            [constants.AddressZero],
            chainIds,
          ),
          'SI',
        );
      },
    ),
  );

  it(
    'Function updateResponseMakers should emit events and update hash',
    embedVersionIncreaseAndEnableTime(
      () => orMakerDeposit.getVersionAndEnableTime().then((r) => r.version),
      async function () {
        const responseSigners = signers.slice(10, 11);
        const responseMakers: BigNumberish[] = [];
        const responseMakerSignatures: BytesLike[] = [];
        const message = arrayify(
          keccak256(
            defaultAbiCoder.encode(['address'], [orMakerDeposit.address]),
          ),
        ); // Convert to byte array to prevent utf-8 decode when signMessage

        for (const s of responseSigners) {
          const signature = await s.signMessage(message);

          responseMakers.push(BigNumber.from(s.address));
          responseMakerSignatures.push(signature);
        }

        utils.verifyMessage(message, responseMakerSignatures[0]);

        const { events } = await orMakerDeposit
          .updateResponseMakers(
            getMinEnableTime(
              (
                await orMakerDeposit.getVersionAndEnableTime()
              ).enableTime,
            ),
            responseMakerSignatures,
          )
          .then((t) => t.wait());

        const args = events?.[0].args;
        expect(args?.responseMakers).to.deep.eq(responseMakers);

        const responseMakersHash = await orMakerDeposit.responseMakersHash();
        expect(responseMakersHash).to.eq(
          keccak256(defaultAbiCoder.encode(['uint[]'], [responseMakers])),
        );

        await testRevertedOwner(
          orMakerDeposit
            .connect(signers[2])
            .updateResponseMakers(
              getMinEnableTime(
                (
                  await orMakerDeposit.getVersionAndEnableTime()
                ).enableTime,
              ),
              responseMakerSignatures,
            ),
        );
      },
    ),
  );

  it('Function deposit should success', async function () {
    const bETHBefore = await mdcOwner.provider?.getBalance(
      orMakerDeposit.address,
    );
    const amountETH = utils.parseEther('0.001');
    await orMakerDeposit
      .deposit(constants.AddressZero, constants.Zero, { value: amountETH })
      .then((t) => t.wait());
    const bETHAfter = await mdcOwner.provider?.getBalance(
      orMakerDeposit.address,
    );
    expect(bETHAfter?.sub(bETHBefore || 0)).eq(amountETH);

    const bERC20Before = await testToken.balanceOf(orMakerDeposit.address);
    const amountERC20 = utils.parseEther('0.001');
    await testToken
      .approve(orMakerDeposit.address, amountERC20)
      .then((t) => t.wait());
    await orMakerDeposit
      .deposit(testToken.address, amountERC20)
      .then((t) => t.wait());
    const bERC20After = await testToken.balanceOf(orMakerDeposit.address);
    expect(bERC20After.sub(bERC20Before)).eq(amountERC20);
  });

  it(
    'Function updateRulesRoot should emit events and update storage',
    embedVersionIncreaseAndEnableTime(
      () => orMakerDeposit.getVersionAndEnableTime().then((r) => r.version),
      async function () {
        // const currentBlock = await mdcOwner.provider?.getBlock('latest');
        const getNative = true;

        const rules: any[] = [];
        for (let i = 0; i < 5 * 4; i++) {
          const _rule = createRandomRule(getNative);
          // _rule[0] = Number(_rule[0]) + i;
          // _rule[1] = Number(_rule[1]) + i;
          // _rule[4] = 0;
          // _rule[5] = 0;
          // console.log(`ethRule - ${ i } : [${ _rule }]`);
          rules.push(_rule);
        }

        const tree = await calculateRulesTree(rules);
        const root = utils.hexlify(tree.root);

        const rootWithVersion = { root, version: 1 };
        const sourceChainIds = [1];
        const pledgeAmounts = [utils.parseEther('0.0001')];

        console.log(`ebc : [${ebc.address}]`);
        await testReverted(
          orMakerDeposit.updateRulesRoot(
            getMinEnableTime(
              (
                await orMakerDeposit.getVersionAndEnableTime()
              ).enableTime,
            ),
            ebc.address,
            rules,
            rootWithVersion,
            sourceChainIds,
            pledgeAmounts,
          ),
          'IV',
        );

        const { events } = await orMakerDeposit
          .updateRulesRoot(
            getMinEnableTime(
              (
                await orMakerDeposit.getVersionAndEnableTime()
              ).enableTime,
            ),
            ebc.address,
            rules,
            rootWithVersion,
            sourceChainIds,
            pledgeAmounts,
            {
              value: pledgeAmounts.reduce((pv, cv) => pv.add(cv)),
            },
          )
          .then((t) => t.wait());

        if (!!events) {
          const txrc = await ethers.provider.getTransaction(
            events[0].transactionHash,
          );
          const recpt = await ethers.provider.getTransactionReceipt(
            events[0].transactionHash,
          );
          const inpudataGas = callDataCost(txrc.data);
          console.log(
            `updateRule, totoalGas: ${recpt.gasUsed}, callDataGasCost: ${inpudataGas}`,
          );
        }
        const args = events?.[0].args;
        expect(args?.ebc).eq(ebc.address);
        expect(args?.rootWithVersion.root).eq(rootWithVersion.root);
        expect(args?.rootWithVersion.version).eq(rootWithVersion.version);

        await testReverted(
          orMakerDeposit.updateRulesRoot(
            getMinEnableTime(
              (
                await orMakerDeposit.getVersionAndEnableTime()
              ).enableTime,
            ),
            ebc.address,
            rules,
            rootWithVersion,
            [],
            [],
          ),
          'VE',
        );
        await testRevertedOwner(
          orMakerDeposit
            .connect(signers[2])
            .updateRulesRoot(
              getMinEnableTime(
                (
                  await orMakerDeposit.getVersionAndEnableTime()
                ).enableTime,
              ),
              ebc.address,
              rules,
              { ...rootWithVersion, version: 2 },
              [],
              [],
            ),
        );

        const storageRWV = await orMakerDeposit.rulesRoot(ebc.address);
        expect(storageRWV.root).eq(rootWithVersion.root);
        expect(storageRWV.version).eq(rootWithVersion.version);

        const key = hexToBuffer(calculateRuleKey(lodash.sample(rules)));
        const proof = await BaseTrie.createProof(tree, key);
        const v = await BaseTrie.verifyProof(
          hexToBuffer(storageRWV.root),
          key,
          proof,
        );
        expect(v !== null).to.be.true;
      },
    ),
  );

  it('Event RulesRootUpdated should emit logs', async function () {
    const rules = await getRulesRootUpdatedLogs(
      signers[0].provider,
      orMakerDeposit.address,
      implementation,
    );
    const tree = await calculateRulesTree(rules);
    const root = utils.hexlify(tree.root);

    const storageRWV = await orMakerDeposit.rulesRoot(ebc.address);
    expect(storageRWV.root).eq(root);
  });

  it(
    'Function updateRulesRootErc20 should emit events and update storage',
    embedVersionIncreaseAndEnableTime(
      () => orMakerDeposit.getVersionAndEnableTime().then((r) => r.version),
      async function () {
        const getNative = false;
        const totalRules: any[] = await getRulesRootUpdatedLogs(
          signers[0].provider,
          orMakerDeposit.address,
          implementation,
        );

        const rules: any[] = [];
        for (let i = 0; i < 5 * 4; i++) {
          const _rule = createRandomRule(getNative);
          totalRules.push(_rule);
          // console.log(`erc20Rule - ${ i } : [${ _rule }]`);
          rules.push(_rule);
        }

        const rootWithVersion = await orMakerDeposit.rulesRoot(ebc.address);

        const tree = await calculateRulesTree(totalRules);
        const root = utils.hexlify(tree.root);
        const sourceChainIds = [rules[rules.length - 1][0]];
        const pledgeAmounts = [utils.parseEther('0.0001')];

        const balanceBefore = await testToken.balanceOf(mdcOwner.address);

        // Approve
        const approveAmount = pledgeAmounts.reduce((pv, cv) => pv.add(cv));
        await testToken
          .approve(orMakerDeposit.address, approveAmount)
          .then((t) => t.wait());

        await orMakerDeposit
          .updateRulesRootERC20(
            getMinEnableTime(
              (
                await orMakerDeposit.getVersionAndEnableTime()
              ).enableTime,
            ),
            ebc.address,
            rules,
            {
              root,
              version: BigNumber.from(rootWithVersion.version).toNumber() + 1,
            },
            sourceChainIds,
            pledgeAmounts,
            testToken.address,
          )
          .then((t) => t.wait());

        const balanceAfter = await testToken.balanceOf(mdcOwner.address);
        expect(balanceBefore.sub(balanceAfter)).eq(approveAmount);

        await testReverted(
          orMakerDeposit.updateRulesRootERC20(
            getMinEnableTime(
              (
                await orMakerDeposit.getVersionAndEnableTime()
              ).enableTime,
            ),
            ebc.address,
            rules,
            {
              root,
              version: BigNumber.from(rootWithVersion.version).toNumber() + 1,
            },
            sourceChainIds,
            pledgeAmounts,
            testToken.address,
          ),
          'VE',
        );
        await testReverted(
          orMakerDeposit.updateRulesRootERC20(
            getMinEnableTime(
              (
                await orMakerDeposit.getVersionAndEnableTime()
              ).enableTime,
            ),
            ebc.address,
            rules,
            {
              root,
              version: BigNumber.from(rootWithVersion.version).toNumber() + 2,
            },
            [],
            pledgeAmounts,
            testToken.address,
          ),
          'SPL',
        );
        await testRevertedOwner(
          orMakerDeposit.connect(signers[2]).updateRulesRootERC20(
            getMinEnableTime(
              (
                await orMakerDeposit.getVersionAndEnableTime()
              ).enableTime,
            ),
            ebc.address,
            rules,
            {
              root,
              version: BigNumber.from(rootWithVersion.version).toNumber() + 2,
            },
            sourceChainIds,
            pledgeAmounts,
            testToken.address,
          ),
        );
      },
    ),
  );

  it('Function withdraw should success', async function () {
    const bETHBefore = await mdcOwner.provider?.getBalance(mdcOwner.address);
    const M_ETH_Before = await ethers.provider.getBalance(
      orMakerDeposit.address,
    );
    const firstRequestInfo = await orMakerDeposit?.getWithdrawRequestList(
      constants.AddressZero,
    );
    expect(BigNumber.from(firstRequestInfo.requestTimestamp)).eq(0);
    await testReverted(orMakerDeposit.withdraw(constants.AddressZero), 'WTN');
    const amountETH = utils.parseEther('0.001');
    const requestReceipt = await orMakerDeposit
      .withdrawRequest(constants.AddressZero, amountETH)
      .then((t) => t.wait());
    const secondRequestInfo = await orMakerDeposit?.getWithdrawRequestList(
      constants.AddressZero,
    );
    expect(BigNumber.from(secondRequestInfo.requestTimestamp)).gt(0);
    await testReverted(
      orMakerDeposit.withdrawRequest(constants.AddressZero, amountETH),
      'RHB',
    );
    await testReverted(orMakerDeposit.withdraw(constants.AddressZero), 'WTN');
    const currentBlockInfo = await ethers.provider.getBlock('latest');
    await mineXTimes(
      BigNumber.from(secondRequestInfo.requestTimestamp)
        .sub(currentBlockInfo.timestamp)
        .toNumber(),
      true,
    );
    const withdrawReceipt = await orMakerDeposit
      .withdraw(constants.AddressZero)
      .then((t) => t.wait());
    const thirdRequestInfo = await orMakerDeposit?.getWithdrawRequestList(
      constants.AddressZero,
    );
    expect(BigNumber.from(thirdRequestInfo.requestTimestamp)).eq(0);
    const bETHAfter = await mdcOwner.provider?.getBalance(mdcOwner.address);
    const requestGasUsed = requestReceipt.gasUsed.mul(
      requestReceipt.effectiveGasPrice,
    );
    const withdrawGasUsed = withdrawReceipt.gasUsed.mul(
      withdrawReceipt.effectiveGasPrice,
    );
    expect(
      bETHAfter
        ?.add(requestGasUsed)
        .add(withdrawGasUsed)
        .sub(bETHBefore || 0),
    ).eq(amountETH);

    const M_ETH_After = await ethers.provider.getBalance(
      orMakerDeposit.address,
    );

    expect(amountETH?.add(M_ETH_After)).eq(M_ETH_Before);

    await testRevertedOwner(
      orMakerDeposit
        .connect(signers[2])
        .withdrawRequest(constants.AddressZero, amountETH),
    );

    await testRevertedOwner(
      orMakerDeposit.connect(signers[2]).withdraw(constants.AddressZero),
    );
  });

  describe('start challenge test module', () => {
    let spvTest: TestSpv;
    let mainnet2eraSpv: ORChallengeSpvMainnet;
    let era2mainnetSpv: ORChallengeSpvEra;
    let makerTest: TestMakerDeposit;
    let rlpDecoder: RLPDecoder;
    const defaultRule = createMakerRule(true);
    const makerRule: RuleStruct = {
      ...defaultRule,
      chainId0: BigNumber.from(300),
      chainId1: BigNumber.from(11155111),
      withholdingFee0: BigNumber.from('3' + '0'.repeat(5)),
      withholdingFee1: BigNumber.from('4' + '0'.repeat(5)),
      responseTime0: defaultResponseTime,
      responseTime1: defaultResponseTime,
    };
    const chainId = makerRule.chainId0;
    const chainIdDest = makerRule.chainId1;

    const m2eSourceProof: BytesLike = getSpvProof().verifySourceProof;
    const m2eDestProof: BytesLike = getSpvProof().verifyDestProof;

    const e2mSourceProof: BytesLike = getSpvProof(
      SPVTypeEnum.era2mainnet,
    ).verifySourceProof;

    const e2mDestProof: BytesLike = getSpvProof(
      SPVTypeEnum.era2mainnet,
    ).verifyDestProof;

    const getRawData = async (
      columnArray: columnArray,
      ebc: string,
      makerRule: RuleStruct,
    ) => {
      const jsEncode = encodeChallengeRawData(
        columnArray.dealers,
        columnArray.ebcs,
        columnArray.chainIds,
        ebc,
        makerRule,
      );

      const contractEncode = await spvTest.encodeRawDatas(
        columnArray.dealers,
        columnArray.ebcs,
        columnArray.chainIds,
        ebc,
        makerRule,
      );

      expect(jsEncode).eql(contractEncode);

      {
        const { dealers, ebcs, chainIds, ebc, rule } =
          await spvTest.decodeRawDatas(utils.arrayify(jsEncode));
        expect(dealers).eql(columnArray.dealers);
        expect(ebcs).eql(columnArray.ebcs);
        expect(chainIds.toString()).eql(columnArray.chainIds.toString());
        expect(rule.chainId0).eql(makerRule.chainId0);
        expect(rule.chainId1).eql(makerRule.chainId1);
        expect(rule.status0).eql(makerRule.status0);
        expect(rule.status1).eql(makerRule.status1);
      }
      const columnArrayHash = utils.keccak256(
        utils.defaultAbiCoder.encode(
          ['uint256[]', 'uint256[]', 'uint256[]'],
          [columnArray.dealers, columnArray.ebcs, columnArray.chainIds],
        ),
      );
      // expect(columnArrayHash).eql(await orMakerDeposit.columnArrayHash());

      return {
        rawData: utils.arrayify(contractEncode),
        columnArrayHash: columnArrayHash,
      };
    };

    before(async function () {
      mainnet2eraSpv = new ORChallengeSpvMainnet__factory(mdcOwner).attach(
        await deploySPVs(mdcOwner),
      );
      console.log('mainnet2eraSpv', mainnet2eraSpv.address);

      era2mainnetSpv = new ORChallengeSpvEra__factory(mdcOwner).attach(
        await deploySPVs(mdcOwner, SPVTypeEnum.era2mainnet),
      );
      console.log('era2mainnetSpv', era2mainnetSpv.address);

      spvTest = await new TestSpv__factory(mdcOwner).deploy(
        mainnet2eraSpv.address,
      );
      await spvTest.deployed();

      rlpDecoder = await new RLPDecoder__factory(mdcOwner).deploy();
      await rlpDecoder.deployed();

      console.log('Address of ruleDecoder: ', rlpDecoder.address);

      console.log(
        `Address of mainnet2eraSpv: ${mainnet2eraSpv.address}, Address of spvTest: ${spvTest.address}, Address of ebc ${ebc.address} `,
      );

      const makerTest_impl = await new TestMakerDeposit__factory(
        signers[0],
      ).deploy();
      await makerTest_impl.deployed();

      const { mdcAddress } = await deployMDC(
        signers[0],
        orManager.address,
        makerTest_impl.address,
      );

      makerTest = new TestMakerDeposit__factory(signers[0]).attach(mdcAddress);
      console.log('connect of makerTest:', makerTest.address);
    });

    it('test function challenge _addChallengeNode', async function () {
      let challengeIdentNumList: bigint[] = [];
      const chains = defaultChainInfoArray.map((chainInfo) => {
        return lodash.cloneDeepWith(chainInfo);
      });

      await Promise.all(
        chains.map(async (chains) => {
          await createRandomChallenge(
            orMakerDeposit,
            BigNumber.from(await chains.id),
          );
        }),
      );

      challengeIdentNumList = challengeManager.numSortingList;
      const lastEleSortNumber = BigNumber.from(challengeIdentNumList[0]);
      const firstEleSortNumber = BigNumber.from(
        challengeIdentNumList[challengeIdentNumList?.length - 1],
      );
      expect(lastEleSortNumber).gt(firstEleSortNumber);
      const canVerify = await orMakerDeposit.canChallengeContinue(
        firstEleSortNumber,
      );
      const cantVerify = await orMakerDeposit.canChallengeContinue(
        lastEleSortNumber,
      );
      expect(canVerify).to.be.true;
      expect(cantVerify).to.be.false;
    });

    it('create challenge test', async function () {
      const case1SourceChainId = chainId;
      const case1SourceTxHash = utils.keccak256(randomBytes(100));
      const case1freezeAmount = utils.formatEther(100000000000001111n);
      // console.log(
      //   `New rule - chain: ${makerRule.chainId0} --> chain: ${makerRule.chainId1}`,
      // );
      const latestBlockRes = await orMakerDeposit.provider?.getBlock('latest');
      const sourceTxTime = (await getCurrentTime()) - defaultResponseTime;
      const sourceChainId = case1SourceChainId;
      const sourceBlockNum = random(latestBlockRes.number);
      const sourceTxIndex = random(100);
      const challengeIdentNum = challengeManager.getChallengeIdentNumSortList(
        sourceTxTime,
        sourceChainId,
        sourceBlockNum,
        sourceTxIndex,
      );
      const challenge: challengeInputInfo = {
        sourceTxTime: (await getCurrentTime()) - defaultResponseTime,
        sourceChainId: case1SourceChainId,
        destChainId: chainIdDest,
        sourceBlockNum,
        sourceTxIndex,
        sourceTxHash: case1SourceTxHash,
        from: await orMakerDeposit.owner(),
        freezeToken: constants.AddressZero,
        freezeAmount: utils.parseEther(case1freezeAmount),
        parentNodeNumOfTargetNode: challengeManager.getLastChallengeIdentNum(
          [],
          challengeIdentNum,
        ),
      };
      const case1balanceOfMakerbefore = utils.formatEther(
        await ethers.provider.getBalance(orMakerDeposit.address),
      );
      await expect(
        orMakerDeposit.checkChallenge(case1SourceChainId, case1SourceTxHash, [
          mdcOwner.address,
        ]),
      ).to.revertedWith('CNE');
      const challengeIdentNumFake =
        challengeManager.getChallengeIdentNumSortList(
          (await getCurrentTime()) + 7800,
          challenge.sourceChainId,
          sourceBlockNum,
          sourceTxIndex,
        );
      const challengeFake: challengeInputInfo = {
        sourceTxTime: (await getCurrentTime()) + 7800,
        sourceChainId: challenge.sourceChainId,
        destChainId: challenge.destChainId,
        sourceBlockNum,
        sourceTxIndex,
        sourceTxHash: challenge.sourceTxHash,
        from: await orMakerDeposit.owner(),
        freezeToken: challenge.freezeToken,
        freezeAmount: challenge.freezeAmount,
        parentNodeNumOfTargetNode: challengeManager.getLastChallengeIdentNum(
          [],
          challengeIdentNumFake,
        ),
      };
      await createChallenge(
        orMakerDeposit,
        challengeFake,
        converRule(makerRule),
        'STOF',
      );
      await createChallenge(orMakerDeposit, challenge, converRule(makerRule));
      await mineXTimes(100);
      await expect(
        orMakerDeposit.checkChallenge(case1SourceChainId, case1SourceTxHash, [
          mdcOwner.address,
        ]),
      ).revertedWith('NCCF');
      const case1balanceOfMakerAfter = utils.formatEther(
        await ethers.provider.getBalance(orMakerDeposit.address),
      );
      // console.log(
      //   `challenge 1 balanceOfMakerbefore: ${case1balanceOfMakerbefore}, balanceOfMakerAfter: ${case1balanceOfMakerAfter}, freezeAmount: ${case1freezeAmount} `,
      // );
      expect(parseFloat(case1balanceOfMakerAfter).toFixed(1)).equal(
        (
          parseFloat(case1balanceOfMakerbefore) +
          parseFloat(case1freezeAmount) +
          0.01
        )
          .toFixed(1)
          .toString(),
      );

      await expect(
        orMakerDeposit.checkChallenge(case1SourceChainId, case1SourceTxHash, [
          mdcOwner.address,
        ]),
      ).to.revertedWith('NCCF');

      const challengeIdentNum2 = challengeManager.getChallengeIdentNumSortList(
        (await getCurrentTime()) - 1,
        challenge.sourceChainId,
        sourceBlockNum,
        sourceTxIndex,
      );
      const challenge2: challengeInputInfo = {
        sourceTxTime: (await getCurrentTime()) - 1,
        sourceChainId: challenge.sourceChainId,
        destChainId: challenge.destChainId,
        sourceBlockNum: sourceBlockNum,
        sourceTxIndex: sourceTxIndex,
        sourceTxHash: challenge.sourceTxHash,
        from: await orMakerDeposit.owner(),
        freezeToken: challenge.freezeToken,
        freezeAmount: challenge.freezeAmount,
        parentNodeNumOfTargetNode: challengeManager.getLastChallengeIdentNum(
          [],
          challengeIdentNum2,
        ),
      };
      await createChallenge(
        orMakerDeposit,
        challenge2,
        converRule(makerRule),
        'CT',
      );
    });

    it('checkChallenge test with no verify source', async function () {
      const sourceTxHash = utils.keccak256(randomBytes(100));
      const freezeAmount = utils.formatEther(100000000000001111n);
      const latestBlockRes = await orMakerDeposit.provider?.getBlock('latest');
      const sourceChainId = await defaultChainInfo.id;
      const sourceBlockNum = random(latestBlockRes.number);
      const sourceTxIndex = random(100);
      const challenge: challengeInputInfo = {
        sourceTxTime: (await getCurrentTime()) - defaultResponseTime,
        sourceChainId: sourceChainId,
        destChainId: chainIdDest,
        sourceBlockNum: sourceBlockNum,
        sourceTxIndex: sourceTxIndex,
        sourceTxHash: sourceTxHash,
        from: await orMakerDeposit.owner(),
        freezeToken: constants.AddressZero,
        freezeAmount: utils.parseEther(freezeAmount),
        parentNodeNumOfTargetNode: 0,
      };
      await createChallenge(orMakerDeposit, challenge, converRule(makerRule));
      const challengeList = challengeManager.getChallengeInfoList();

      // i >= 1: min challengeIdentNum node will pass
      for (let i = challengeList.length - 1; i >= 1; i--) {
        await expect(
          orMakerDeposit.checkChallenge(
            challengeList[i].sourceChainId,
            challengeList[i].sourceTxHash,
            [mdcOwner.address],
          ),
        ).to.revertedWith('NCCF');
      }

      for (let i = 0; i < challengeList.length; i++) {
        await liquidateChallenge(
          orMakerDeposit,
          [challengeList[i]],
          [mdcOwner.address],
        );
      }

      expect(challengeManager.getChallengeInfoList().length).eq(0);
    });

    it('checkChallenge test with special challengeId', async function () {
      const sourceTxHash = utils.keccak256(randomBytes(100));
      const freezeAmount = utils.formatEther(100000000000001111n);
      const latestBlockRes = await orMakerDeposit.provider?.getBlock('latest');
      const sourceChainId = defaultChainInfoArray[0].id;
      const sourceBlockNum = random(latestBlockRes.number);
      const sourceTxIndex = random(100);
      // const chains = defaultChainInfoArray.map((chainInfo) => {
      //   return lodash.cloneDeepWith(chainInfo);
      // });

      const maxVerifyTime: number = (
        await orManager.getChainInfo(sourceChainId)
      ).maxVerifyChallengeSourceTxSecond.toNumber();

      const currentTime: number = await getCurrentTime();

      const challengerList: string[] = [];

      for (let i = 0; i < 5; i++) {
        const maker = new ORMakerDeposit__factory(signers[i]).attach(
          orMakerDeposit.address,
        );
        const challenge: challengeInputInfo = {
          sourceTxTime: currentTime - maxVerifyTime,
          sourceChainId: sourceChainId.toString(),
          destChainId: chainIdDest,
          sourceBlockNum: sourceBlockNum,
          sourceTxIndex: sourceTxIndex,
          sourceTxHash: sourceTxHash,
          from: await orMakerDeposit.owner(),
          freezeToken: constants.AddressZero,
          freezeAmount: utils.parseEther(freezeAmount),
          parentNodeNumOfTargetNode: 0,
        };
        await createChallenge(maker, challenge, converRule(makerRule));
        challengerList.push(signers[i].address);
      }
      const challengeList = challengeManager.getChallengeInfoList();
      await liquidateChallenge(orMakerDeposit, challengeList, challengerList);
      expect(challengeManager.getChallengeInfoList().length).eq(0);
    });
  });
});
