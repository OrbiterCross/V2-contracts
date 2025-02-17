/* eslint-disable prettier/prettier */
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { assert, expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { ethers } from 'hardhat';
import fs from 'fs';
import { defaultAbiCoder, keccak256 } from 'ethers/lib/utils';
import {
  ORFeeManager,
  ORFeeManager__factory,
  ORManager,
  ORManager__factory,
  TestToken,
  TestToken__factory,
} from '../typechain-types';
import { log } from 'console';

import {
  MergeValue,
  SMTLeaf,
  SubmitInfo,
  SubmitInfoMock,
  callDataCost,
  dealersSignersMock,
  initTestToken,
  mineXTimes,
  stateTransTreeRootMock,
  submitterMock,
  submitter_getProfitProof,
} from './lib/mockData';


const tokensRequestList: string[] = [
  '0x0000000000000000000000000000000000000000',
  '0xa0321efEb50c46C17A7D72A52024eeA7221b215A',
  '0xA3a8A6b323E3d38f5284db9337e7c6d74Af3366a',
  '0x29B6a77911c1ce3B3849f28721C65DadA015c768'
];
const userAddress = '0xc3C7A782dda00a8E61Cb9Ba0ea8680bb3f3B9d10';

let proof: withdrawVerification;
let profitRoot: string;

enum MergeValueType {
  VALUE = 0,
  MERGE_WITH_ZERO,
  SHORT_CUT,
}

type Bitmaps = string[];

type WithdrawAmount = BigNumber[];

type StartIndex = number[];

type FirstZeroBits = string[];

interface IMergeWithZero {
  MergeWithZero: {
    base_node: string;
    zero_bits: string;
    zero_count: number;
  };
}

interface IValue {
  Value: string;
}

interface IShortCut {
  height: string;
  key: string;
  value: string;
}

export interface IProofItem {
  leave_bitmap: string;
  no1_merge_value: [number, string];
  path: string;
  siblings: Array<IMergeWithZero & IValue & IShortCut>;
  root: string;
  token: {
    balance: string;
    debt: string;
    token: string;
    token_chain_id: number;
  };
}

interface withdrawVerification {
  smtLeaf: SMTLeaf[];
  siblings: MergeValue[][];
  startIndex: number[];
  firstZeroBits: string[];
  bitmaps: string[];
  withdrawAmount: BigNumber[];
}

const getWithDrawParams = (result: IProofItem[]) => {
  const smtLeaves: SMTLeaf[] = [];
  const siblings: MergeValue[][] = [];
  const bitmaps: Bitmaps = [];
  const withdrawAmount: WithdrawAmount = [];
  const startIndex: StartIndex = [];
  const firstZeroBits: FirstZeroBits = [];
  const root: string[] = [];

  result.forEach((v) => {
    const cSiblings = v.siblings;
    const cToken = v.token;
    const cBitmap = v.leave_bitmap;
    const cRoot = v.root;
    smtLeaves.push({
      chainId: BigNumber.from(cToken.token_chain_id),
      token: cToken.token,
      user: userAddress,
      amount: BigNumber.from(cToken.balance),
      debt: BigNumber.from(cToken.debt),
    });
    const vSiblings: MergeValue[] = [];
    cSiblings.forEach((s) => {
      const mergeType = !!s.MergeWithZero
        ? MergeValueType.MERGE_WITH_ZERO
        : !!s.Value
          ? MergeValueType.VALUE
          : MergeValueType.SHORT_CUT;
      const mergeValue = !!s.MergeWithZero
        ? {
          value1: s.MergeWithZero.zero_count,
          value2: '0x' + s.MergeWithZero.base_node,
          value3: '0x' + s.MergeWithZero.zero_bits,
        }
        : {
          value1: 0,
          value2: '0x' + s.Value,
          value3:
            '0x0000000000000000000000000000000000000000000000000000000000000000',
        };
      vSiblings.push({
        mergeType: mergeType,
        mergeValue: {
          value1: mergeValue.value1,
          value2: utils.arrayify(mergeValue.value2),
          value3: utils.arrayify(mergeValue.value3),
        },
      });
    });
    siblings.push(vSiblings);
    startIndex.push(v.no1_merge_value[0]);
    firstZeroBits.push('0x' + v.no1_merge_value[1]);
    bitmaps.push('0x' + cBitmap);
    root.push('0x' + cRoot);
    withdrawAmount.push(BigNumber.from(cToken.balance));
  });

  return {
    smtLeaves,
    siblings,
    startIndex,
    firstZeroBits,
    bitmaps,
    root,
    withdrawAmount,
  };
};

describe('Test RPC', () => {
  it('should communicate with the external RPC and parse JSON data', async () => {
    if (process.env['SUBMITTER_RPC'] != undefined) {
      const tokenArray: [number, string][] = [];
      for (let i = 0; i < tokensRequestList.length; i++) {
        tokenArray.push([5, tokensRequestList[i]]);
      }
      await submitter_getProfitProof(tokenArray, userAddress);
    }
  });
});

describe('format RPC json data', () => {
  let fileData: string;
  let parsedData: any;
  before(async function () {
    if (process.env['SUBMITTER_RPC'] != undefined) {
      fileData = fs.readFileSync('test/RPC_DATA/response.json', 'utf-8');
      parsedData = JSON.parse(fileData);
    } else {
      fileData = fs.readFileSync('test/dataSample.json', 'utf-8');
      parsedData = JSON.parse(fileData);
    }

    try {
      console.log(parsedData.result);
      const {
        smtLeaves,
        siblings,
        startIndex,
        firstZeroBits,
        bitmaps,
        root,
        withdrawAmount,
      } = getWithDrawParams(parsedData.result);
      proof = {
        smtLeaf: smtLeaves,
        siblings: siblings,
        startIndex: startIndex,
        firstZeroBits: firstZeroBits,
        bitmaps: bitmaps,
        withdrawAmount: withdrawAmount,
      };
      profitRoot = root[0];
    } catch (error) {
      assert(false, "error");
    }

  });

  it('should format JSON data', async () => {
    console.log(`proof: ${proof}, root: ${profitRoot}`);
  });

});


describe('test ORFeeManager MerkleVerify', () => {
  let signers: SignerWithAddress[];
  let orManager: ORManager;
  let orFeeManager: ORFeeManager;
  let DEALER_WITHDRAW_DELAY: number;
  let WITHDRAW_DURATION: number;
  let LOCK_DURATION: number;
  const secondsInMinute = 60;
  let challengeTime: number;
  let withdrawTime: number;
  let lockTime: number;

  before(async function () {
    initTestToken();
    signers = await ethers.getSigners();
    DEALER_WITHDRAW_DELAY = 3600;
    WITHDRAW_DURATION = 3360;
    LOCK_DURATION = 240;

    challengeTime = DEALER_WITHDRAW_DELAY / secondsInMinute;
    withdrawTime = WITHDRAW_DURATION / secondsInMinute;
    lockTime = LOCK_DURATION / secondsInMinute;

    const envORManagerAddress = process.env['OR_MANAGER_ADDRESS'];
    assert(
      !!envORManagerAddress,
      'Env miss [OR_MANAGER_ADDRESS]. You may need to test ORManager.test.ts first. Example: npx hardhat test --bail test/ORManager.test test/ORFeeManager.test.ts test/ORMDCFactory.test.ts test/ORMakerDeposit.test.ts test/ORFeeManagerMerkleVerify.test.ts',
    );

    const envOFeeRManagerAddress = process.env['OR_FEE_MANAGER_ADDRESS'];
    assert(
      !!envOFeeRManagerAddress,
      'Env miss [OR_FEE_MANAGER_ADDRESS]. You may need to test ORManager.test.ts first. Example: npx hardhat test --bail test/ORManager.test test/ORFeeManager.test.ts test/ORMDCFactory.test.ts test/ORMakerDeposit.test.ts test/ORFeeManagerMerkleVerify.test.ts',
    );

    orManager = new ORManager__factory(signers[0]).attach(envORManagerAddress);
    await orManager.deployed();


    if (process.env['OR_FEE_MANAGER_ADDRESS'] != undefined) {
      orFeeManager = new ORFeeManager__factory(signers[0]).attach(
        process.env['OR_FEE_MANAGER_ADDRESS'],
      );
      console.log('connected to orFeeManager:', orFeeManager.address);
    } else {
      orFeeManager = await new ORFeeManager__factory(signers[0]).deploy(
        signers[1].address,
        orManager.address
      );
      console.log('Address of orFeeManager:', orFeeManager.address);
      await orFeeManager.deployed();
    }

    const testToken: TestToken = await new TestToken__factory(
      signers[0],
    ).deploy('TestToken', 'OTT');
    console.log('Address of testToken:', testToken.address);

  });


  it("ORFeeManager's functions prefixed with _ should be private", async function () {
    for (const key in orFeeManager.functions) {
      expect(key.replace(/^_/, '')).eq(key);
    }
  });

  it('withdraw during initail state', async function () {
    const smtLeaf = proof.smtLeaf;
    const siblings = getEncodeSbilings(proof.siblings)
    const bitmaps = proof.bitmaps;
    const withdrawAmount: BigNumber[] = [];
    for (let i = 0; i < smtLeaf.length; i++) {
      withdrawAmount.push(smtLeaf[i].amount);
    }
    const startIndex = proof.startIndex;
    const firstZeroBits = proof.firstZeroBits;
    await gotoDuration(durationStatusEnum['lock']);
    await expect(orFeeManager
      .withdrawVerification(
        smtLeaf,
        siblings,
        startIndex,
        firstZeroBits,
        bitmaps,
        withdrawAmount,
        {
          gasLimit: 10000000,
        },
      )).to.revertedWith('WE')
    await gotoDuration(durationStatusEnum['withdraw']);
    await expect(orFeeManager
      .withdrawVerification(
        smtLeaf,
        siblings,
        startIndex,
        firstZeroBits,
        bitmaps,
        withdrawAmount,
        {
          gasLimit: 10000000,
        },
      )).to.revertedWith('WL')
  });

  it('Function updateDealer should emit events and update dealerInfo', async function () {
    const feeRatio = BigNumber.from(1000);
    const extraInfoTypes = ['string', 'string'];
    const extraInfoValues = ['https://orbiter.finance/', '@Orbiter_Finance'];
    const extraInfo = defaultAbiCoder.encode(extraInfoTypes, extraInfoValues);

    const dealersigners: SignerWithAddress[] = await dealersSignersMock();

    await Promise.all(
      dealersigners.map(async (dealersigner) => {
        const { events } = await orFeeManager
          .connect(dealersigner)
          .updateDealer(feeRatio, extraInfo)
          .then((t) => t.wait());

        const args = events?.[0].args;
        expect(args?.dealer).eq(dealersigner.address);
        expect(args?.feeRatio).eq(feeRatio);
        expect(args?.extraInfo).eq(extraInfo);

        const dealerInfo = await orFeeManager.getDealerInfo(
          dealersigner.address,
        );
        log('Address of dealer:', dealersigner.address);
        expect(dealerInfo.feeRatio).eq(feeRatio);
        expect(dealerInfo.extraInfoHash).eq(keccak256(extraInfo));
      }),
    );
  });

  async function registerSubmitter(marginAmount: BigNumber) {
    const submitter = await submitterMock();
    await orFeeManager.registerSubmitter(marginAmount, submitter);
  }

  async function submit(profitRoot: string) {
    const submitInfo: SubmitInfo = await SubmitInfoMock();
    const submissions = await orFeeManager.submissions();
    submitInfo.profitRoot = profitRoot;
    submitInfo.stratBlock = submissions.endBlock.toNumber();
    submitInfo.endBlock = submitInfo.stratBlock + 1;

    const events = await orFeeManager
      .submit(
        submitInfo.stratBlock,
        submitInfo.endBlock,
        submitInfo.profitRoot,
        submitInfo.stateTransTreeRoot,
      )
      .then((t) => t.wait());
    return events;
  }

  enum durationStatusEnum {
    lock = 0,
    challenge = 1,
    withdraw = 2,
  }

  async function durationCheck() {
    return await orFeeManager.durationCheck();
  }

  async function withdraw(
    smtLeaf: SMTLeaf[],
    siblings: string[][],
    startIndex: StartIndex,
    firstZeroBits: string[],
    bitmaps: string[],
    withdrawAmount: WithdrawAmount,
    loop: number,
  ) {
    try {
      const tx = await orFeeManager
        .withdrawVerification(
          smtLeaf,
          siblings,
          startIndex,
          firstZeroBits,
          bitmaps,
          withdrawAmount,
          {
            gasLimit: 10000000,
          },
        )
        .then((t) => t.wait());
      const txrc = await ethers.provider.getTransaction(tx.transactionHash);
      const inpudataGas = callDataCost(txrc.data);
      console.log(
        `loop: [${loop + 1}]-withdraw gas used: ${tx.gasUsed}, input data gas: ${inpudataGas}`,
      );
    } catch (error) {
      assert(false, "error")
    }
  }

  async function gotoDuration(duration: durationStatusEnum) {
    while ((await durationCheck()) != duration) {
      await mineXTimes(3);
    }
  }
  /**
   * Generates an array of encoded siblings.
   * @param {MergeValue[][]} siblings - The array of siblings to encode.
   * @return {string[][]} The array of encoded siblings.
   */
  function getEncodeSbilings(siblings: MergeValue[][]): string[][] {
    return siblings.map((sibling) => {
      return sibling.map((v) => {
        if (v.mergeType == 1) {
          return keccak256(
            defaultAbiCoder.encode(
              ['uint8', 'bytes32', 'bytes32', 'uint8'],
              [2, v.mergeValue.value2, v.mergeValue.value3, v.mergeValue.value1]
            )
          );
        } else {
          return v.mergeValue.value2 as unknown as string;
        }
      });
    });
  }

  it('submitter register statues should manually set by feeManager owner', async function () {
    const marginAmount = BigNumber.from(1000);

    await registerSubmitter(marginAmount);
    expect(await orFeeManager.submitter(await submitterMock())).eq(
      marginAmount,
    )
    await gotoDuration(durationStatusEnum['lock']);
    expect(await orFeeManager
      .submit(
        0,
        1,
        keccak256(orFeeManager.address),
        keccak256(orFeeManager.address),
      )
    ).to.be.satisfy
    await gotoDuration(durationStatusEnum['withdraw']);
    await expect(orFeeManager
      .submit(
        10000,
        1,
        keccak256(orFeeManager.address),
        keccak256(orFeeManager.address),
      )
    ).to.revertedWith('NL2')

    await gotoDuration(durationStatusEnum['withdraw']);
    await gotoDuration(durationStatusEnum['lock']);
    await expect(orFeeManager
      .submit(
        10000,
        1,
        keccak256(orFeeManager.address),
        keccak256(orFeeManager.address),
      )
    ).to.revertedWith('EB')
    await gotoDuration(durationStatusEnum['withdraw']);
    await gotoDuration(durationStatusEnum['lock']);
    await expect(orFeeManager
      .submit(
        0,
        1,
        keccak256(orFeeManager.address),
        keccak256(orFeeManager.address),
      )
    ).to.revertedWith('BE')

    const unregisterMarginAmount = BigNumber.from(0);
    await registerSubmitter(unregisterMarginAmount);
    expect(await orFeeManager.submitter(await submitterMock())).eq(
      unregisterMarginAmount,
    )
    await gotoDuration(durationStatusEnum['lock']);
    await expect(orFeeManager
      .submit(
        0,
        1,
        keccak256(orFeeManager.address),
        keccak256(orFeeManager.address),
      )
    ).to.revertedWith('NS')
  })

  it('mine to test should succeed', async function () {
    await registerSubmitter(BigNumber.from(1000));
    await gotoDuration(durationStatusEnum['lock']);

    await submit(profitRoot);
    const submissions = await orFeeManager.submissions();
    expect(submissions.profitRoot).eq(profitRoot);
    expect(submissions.stateTransTreeRoot).eq(stateTransTreeRootMock);

    expect(await durationCheck()).eq(durationStatusEnum['challenge']);
    await mineXTimes(challengeTime + 1);
    expect(await durationCheck()).eq(durationStatusEnum['withdraw']);
    await mineXTimes(withdrawTime);
    expect(await durationCheck()).eq(durationStatusEnum['lock']);
    await mineXTimes(lockTime);
    expect(await durationCheck()).eq(durationStatusEnum['withdraw']);
    await mineXTimes(withdrawTime);
    expect(await durationCheck()).eq(durationStatusEnum['lock']);
    await mineXTimes(lockTime);
    expect(await durationCheck()).eq(durationStatusEnum['withdraw']);
    await mineXTimes(withdrawTime);
    expect(await durationCheck()).eq(durationStatusEnum['lock']);
    await mineXTimes(lockTime);
    expect(await durationCheck()).eq(durationStatusEnum['withdraw']);
    await mineXTimes(withdrawTime);
    expect(await durationCheck()).eq(durationStatusEnum['lock']);
    await mineXTimes(lockTime);
    expect(await durationCheck()).eq(durationStatusEnum['withdraw']);
    await mineXTimes(withdrawTime);
    expect(await durationCheck()).eq(durationStatusEnum['lock']);
    await mineXTimes(lockTime);
    expect(await durationCheck()).eq(durationStatusEnum['withdraw']);
  });

  it('verify should succeed', async function () {
    const smtLeaf = proof.smtLeaf;
    const siblings = getEncodeSbilings(proof.siblings)
    const bitmaps = proof.bitmaps;
    const withdrawAmount: BigNumber[] = smtLeaf.map(item => item.amount);
    const startIndex = proof.startIndex;
    const firstZeroBits = proof.firstZeroBits;

    await gotoDuration(durationStatusEnum['withdraw']);
    try {
      console.log("estimateGas-withdrawVerification =",
        await orFeeManager
          .estimateGas
          .withdrawVerification(
            smtLeaf,
            siblings,
            startIndex,
            firstZeroBits,
            bitmaps,
            withdrawAmount,
            {
              gasLimit: 10000000,
            },
          ))
    } catch (error: any) {
      console.log(`error: ${error.message}`)
      assert(false, "error")
    }


    for (let i = 0; i < 5; i++) {
      await gotoDuration(durationStatusEnum['lock']);
      await expect(orFeeManager
        .withdrawVerification(
          smtLeaf,
          siblings,
          startIndex,
          firstZeroBits,
          bitmaps,
          withdrawAmount,
          {
            gasLimit: 10000000,
          },
        )).to.revertedWith('WE')
      await submit(profitRoot);
      await gotoDuration(durationStatusEnum['challenge']);
      await expect(orFeeManager
        .withdrawVerification(
          smtLeaf,
          siblings,
          startIndex,
          firstZeroBits,
          bitmaps,
          withdrawAmount,
          {
            gasLimit: 10000000,
          },
        )).to.revertedWith('WE')
      await gotoDuration(durationStatusEnum['withdraw']);
      await withdraw(
        smtLeaf,
        siblings,
        startIndex,
        firstZeroBits,
        bitmaps,
        withdrawAmount,
        i
      )
      await expect(orFeeManager
        .withdrawVerification(
          smtLeaf,
          siblings,
          startIndex,
          firstZeroBits,
          bitmaps,
          withdrawAmount,
          {
            gasLimit: 10000000,
          },
        )).to.revertedWith('WL')
    }

    await gotoDuration(durationStatusEnum['withdraw']);
    await expect(orFeeManager
      .withdrawVerification(
        smtLeaf,
        siblings,
        startIndex,
        firstZeroBits,
        bitmaps,
        withdrawAmount,
        {
          gasLimit: 10000000,
        },
      )).to.revertedWith('WL')
    await gotoDuration(durationStatusEnum['lock']);
    await expect(orFeeManager
      .withdrawVerification(
        smtLeaf,
        siblings,
        startIndex,
        firstZeroBits,
        bitmaps,
        withdrawAmount,
        {
          gasLimit: 10000000,
        },
      )).to.revertedWith('WE')
    await gotoDuration(durationStatusEnum['withdraw']);
    await expect(orFeeManager
      .withdrawVerification(
        smtLeaf,
        siblings,
        startIndex,
        firstZeroBits,
        bitmaps,
        withdrawAmount,
        {
          gasLimit: 10000000,
        },
      )).to.revertedWith('WL')

    await gotoDuration(durationStatusEnum['lock']);
    await submit(profitRoot);
    await gotoDuration(durationStatusEnum['withdraw']);
    expect(await orFeeManager
      .withdrawVerification(
        smtLeaf,
        siblings,
        startIndex,
        firstZeroBits,
        bitmaps,
        withdrawAmount,
        {
          gasLimit: 10000000,
        },
      )).to.be.satisfy

    await expect(orFeeManager
      .withdrawVerification(
        smtLeaf,
        siblings,
        startIndex,
        firstZeroBits,
        bitmaps,
        withdrawAmount,
        {
          gasLimit: 10000000,
        },
      )).to.revertedWith('WL')

    await gotoDuration(durationStatusEnum['lock']);
    await submit(profitRoot);
    await gotoDuration(durationStatusEnum['withdraw']);
    smtLeaf[0].user = '0xA00000000000000000000000000000000000000A';
    await expect(orFeeManager
      .withdrawVerification(
        smtLeaf,
        siblings,
        startIndex,
        firstZeroBits,
        bitmaps,
        withdrawAmount,
        {
          gasLimit: 10000000,
        },
      )).to.revertedWith("NU")

  });

  it('one leaf verify should succeed', async function () {
    const fileData = '{"jsonrpc":"2.0","result":[{"path":"9a05d89903c318fd4a9bf0ec37a2341918b5d0783eab9743d65d5ef98e43efc2","leave_bitmap":"0000000000000000000000000000000000000000000000000000000000000000","token":{"token":"0x29b6a77911c1ce3b3849f28721c65dada015c768","token_chain_id":5,"balance":"0xa12bc40","debt":"0x0"},"siblings":[{"Value":"ab6804bcf368f7a8b282b27d940d0a213b19fb2d3fe3d12518fd16121849a0b4"}],"root":"a0a75b9687bf81284b0c7bf901f914e1b23356870475ed48e052c771c4bfbff5","no1_merge_value":[255,"0000000000000000000000000000000000000000000000000000000000000000"]}],"id":1}'
    const parsedData: any = JSON.parse(fileData);
    let oneLeafProof: withdrawVerification;
    let oneLeafprofitRoot: string;
    try {
      const {
        smtLeaves,
        siblings,
        startIndex,
        firstZeroBits,
        bitmaps,
        root,
        withdrawAmount,
      } = getWithDrawParams(parsedData.result);
      oneLeafProof = {
        smtLeaf: smtLeaves,
        siblings: siblings,
        startIndex: startIndex,
        firstZeroBits: firstZeroBits,
        bitmaps: bitmaps,
        withdrawAmount: withdrawAmount,
      };
      oneLeafprofitRoot = root[0];
    } catch (error) {
      assert(false, "error");
    }

    const smtLeaf = oneLeafProof.smtLeaf;
    const siblings = getEncodeSbilings(oneLeafProof.siblings)
    const bitmaps = oneLeafProof.bitmaps;
    const withdrawAmount: BigNumber[] = smtLeaf.map(item => item.amount);
    const startIndex = oneLeafProof.startIndex;
    const firstZeroBits = oneLeafProof.firstZeroBits;

    await gotoDuration(durationStatusEnum['lock']);
    await submit(oneLeafprofitRoot);
    await gotoDuration(durationStatusEnum['withdraw']);
    expect(bitmaps[0]).eq('0x0000000000000000000000000000000000000000000000000000000000000000');
    await withdraw(
      smtLeaf,
      siblings,
      startIndex,
      firstZeroBits,
      bitmaps,
      withdrawAmount,
      998
    )

    await expect(orFeeManager
      .withdrawVerification(
        smtLeaf,
        siblings,
        startIndex,
        firstZeroBits,
        bitmaps,
        withdrawAmount,
        {
          gasLimit: 10000000,
        },
      )).to.revertedWith('WL')

  });
});
