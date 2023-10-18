// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

interface IORSpvData {
    struct InjectionBlock {
        uint blockNumber;
        bytes32 blockHash;
    }

    event BlockIntervalUpdated(uint64 blockInterval);
    event HistoryBlockSaved(uint indexed blockNumber, bytes32 blockHash);

    function getBlockHash(uint blockNumber) external view returns (bytes32);

    function saveHistoryBlocks() external;

    function getBlockInterval() external view returns (uint64);

    function updateBlockInterval(uint64 blockInterval) external;

    function injectBlocksByManager(
        uint startBlockNumber,
        uint endBlockNumber,
        InjectionBlock[] calldata injectionBlocks
    ) external;
}
