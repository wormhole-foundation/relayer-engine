# Plugin Relayers

[TOC]

## Objective

Define the relayer template / scaffold that consists of all of the boilerplate code that defines all of the base functionality of a relayer to transport a message from Chain A to Chain B and the interface to perform additional arbitrary off-chain computation.

This template / scaffold will serve as the base relayer for 
- specialized relayers that applications can run to serve a specific functionality
- modular relayers in the form of a permissionless network to service users / applications by submitting arbitrary messages to arbitrary chains

## Background

Prior to plug-in relayers, there is no modularized template for projects who want to spin up and run relayers to reference. This leads to home rolled solutions or ones that are modified from the [spy relayer](https://github.com/wormhole-foundation/wormhole/tree/dev.v2/relayer/spy_relayer). This is undesirable as it adds more code-complexity and slows down integration efforts.

## Goals

- Define a relayer template that can be spun up and maintained out of the box with all base functionality
    - crash / error recovery
    - manage hot wallets
    - listen to Guardian gossip network
    - submit transactions on-chain
- Define the relayer interface to enable applications to define arbitrary off-chain computation

## Non-Goals

- Design the economic incentives behind a relayer network

## Overview

Plug-in relayers will serve as the foundation that future relayer development will be based upon, whether that is by application developers to provide dedicated relaying services for their application or by third party participants to provide general relaying service to the broader Wormhole ecosystem.

Plug-in relayers will define the template for future modules to be developed and reduce the barrier for relaying services to be spun up.

## Detailed Design

There are four main components to a relayer:
1. Non-validating guardiand node that is connected to the Guardian Gossip Network.
2. Listener that observes the activity on the Guardian Gossip Network and optionally filters for certain VAAs based on `emitterAddress` and `emitterChainID`.
3. Redis database that VAAs are enqueued on by the Listener.
4. Executor that pops off VAAs from the Redis database, processes it, and optionally generate subsequent actions.

The Plug-in relayer modularizes the Listener and Executor component through a Plug-in Interface to enable custom filtering and off-chain processing of VAAs respectively.

The Listener portion of the Plug-in component defines 
- type of connection to the Guardian Network (Spy connection or REST API)
- VAA filter by `emitterAddress` and `emitterChainID`
- process for consuming a VAA

The Executor portion of the Plug-in component defines, for each blockchain ecosystem that the relayer needs to support (i.e. EVM, Solana, Cosmos) the
- wallet tool box
- action(s) to take based on a consumed VAA 

The key interfaces to provide in a plug-in can be found [here](https://github.com/wormhole-foundation/wormhole/blob/feat/plugin_relayer/relayer/plugin_interface/src/index.ts)